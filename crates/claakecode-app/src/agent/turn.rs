use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    time::Duration,
};

use futures_util::StreamExt;
use rand::Rng;
use serde_json::{json, Map, Value};
use tokio::{sync::mpsc, task::JoinHandle};
use uuid::Uuid;
use std::path::Path;

use claakecode_core::{
    AppError, ChatMessage, Part, PartKind, ProviderRequest, Role, StopReason, StreamEvent,
    ToolResultImage,
};

use super::{
    assistant_message::AssistantMessageBuilder,
    cancel::EngineCommand,
    clean_context::{clean_context_descriptor, run_clean_context},
    compaction::{
        can_auto_compact_history, is_context_length_error, maybe_auto_compact_history,
        run_auto_compaction,
    },
    context::{AgentMode, RunHandle, TurnContext, TurnOutput},
    events::{attach_token_usage, send_event, send_token_usage_event, AgentEvent, AgentEventScope},
    history::{
        append_interrupted_tool_results, history_with_current_tool_result_ids,
        normalize_tool_call_inputs, repair_missing_tool_results, strip_all_visible_tool_result_ids,
        successful_read_fingerprints,
    },
    mode::{run_update_goal, system_prompt_for_turn, update_goal_descriptor},
    tool_dispatch::{
        is_parallel_safe, run_parallel_safe_tool, run_tool, should_wait_for_cooperative_cancel,
    },
    tool_preflight::{preflight_error_result, ToolPreflightRegistry},
    tool_summary::{display_mcp_server_name, pretty_json, should_stream_tool_args, summarize_tool},
};

use crate::{
    run_engine::{
        advance, head_commit, run_path, step_instruction, system_block, Graph, Guard, Recovered, Run,
        RunStatus, Verdict,
    },
    system_prompt_with_todo, tool_names, AppStore, ReadFingerprint, TodoListState, ToolRunResult,
};

const SAFE_STREAM_MAX_RETRIES: usize = 5;

pub async fn run_turn(ctx: TurnContext) -> TurnOutput {
    let TurnContext {
        provider,
        model,
        cache_key,
        mut cache_stable_message_count,
        service_tier,
        auto_compact,
        mode,
        mut stop_questions,
        system_prompt,
        mut history,
        mut todo_list,
        mut goal_workflow,
        bash,
        python,
        glob,
        grep,
        read,
        edit_file,
        write_file,
        create_image,
        todo_list_tool,
        question,
        web_search,
        web_fetch,
        skill,
        database,
        mcp,
        subagents,
        teams,
        tool_settings,
        event_scope,
        max_tool_rounds,
        event_tx,
        cancel,
        mut cmd_rx,
        run,
    } = ctx;

    let mut measurement = crate::model_turns::TurnMeasurement::new(
        cache_key.clone().unwrap_or_default(), model.provider.clone(), model.name.clone(),
        "classic", event_scope.is_some(), if event_scope.is_none() { history.len().checked_sub(1) } else { None },
    );
    let measurement_store = database.store();
    send_event(&event_tx, event_scope.as_ref(), AgentEvent::TurnStarted);
    strip_all_visible_tool_result_ids(&mut history);
    normalize_tool_call_inputs(&mut history);
    repair_missing_tool_results(&mut history);
    mcp.refresh_catalog(&history).await;

    let mut cancelled = false;
    let mut compacted = false;
    let mut loops = 0usize;
    let mut auto_compaction_attempts = 0usize;
    let mut current_turn_tool_result_ids = BTreeSet::new();
    let mut eager_tool_results = BTreeMap::<String, JoinHandle<ToolRunResult>>::new();
    let mut read_fingerprints = successful_read_fingerprints(&history, &read);
    let mut active_run = run.as_ref().and_then(|handle| {
        Run::load(&run_path(&handle.workspace_root, &handle.conversation_id))
            .ok()
            .flatten()
            .filter(|run| run.status == RunStatus::Active)
    });
    let mut step_changed_paths = BTreeSet::<String>::new();
    let mut todo_final_answer_guard_attempted = false;
    todo_list.normalize();

    'conversation: loop {
        if let Some(teams) = &teams {
            if let Some(messages_prompt) = teams.drain_current_agent_messages_prompt().await {
                history.push(ChatMessage {
                    role: Role::User,
                    parts: vec![Part::Text {
                        text: messages_prompt,
                        meta: Some(json!({ "agent_team_messages": true })),
                    }],
                });
            }
        }

        let mut tool_descriptors = if mode == AgentMode::Ask {
            vec![
                glob.descriptor(),
                grep.descriptor(),
                crate::mgrep::descriptor(),
                read.descriptor(),
                clean_context_descriptor(),
                web_search.descriptor(),
                web_fetch.descriptor(),
            ]
        } else {
            vec![
                bash.descriptor(),
                bash.input_descriptor(),
                python.descriptor(),
                glob.descriptor(),
                grep.descriptor(),
                crate::mgrep::descriptor(),
                read.descriptor(),
                clean_context_descriptor(),
                web_search.descriptor(),
                web_fetch.descriptor(),
            ]
        };
        if mode != AgentMode::Ask {
            if let Some(question) = &question {
                tool_descriptors.insert(7, question.descriptor());
            }
            if let Some(todo_list_tool) = &todo_list_tool {
                tool_descriptors.insert(7, todo_list_tool.descriptor());
            }
            if let Some(descriptor) = skill.descriptor() {
                tool_descriptors.push(descriptor);
            }
            tool_descriptors.extend(database.descriptors());
        }
        if !matches!(mode, AgentMode::Plan | AgentMode::Ask) {
            tool_descriptors.insert(4, edit_file.descriptor());
            tool_descriptors.insert(5, write_file.descriptor());
            tool_descriptors.push(create_image.descriptor());
        }
        if mode == AgentMode::Goal {
            tool_descriptors.push(update_goal_descriptor());
        }
        if mode != AgentMode::Ask {
            tool_descriptors.extend(mcp.descriptors().await);
            if let Some(subagents) = &subagents {
                tool_descriptors.extend(subagents.descriptors());
            }
            if let Some(teams) = &teams {
                tool_descriptors.extend(teams.descriptors());
            }
        }
        let tool_descriptors = tool_settings.apply_to_descriptors(tool_descriptors);
        let question_enabled = question.is_some() && tool_settings.is_enabled(tool_names::QUESTION);

        let mut current_system_prompt = system_prompt_with_todo(&system_prompt, &todo_list);
        if let Some(teams) = &teams {
            if let Some(team_reminder) = teams.current_agent_system_reminder().await {
                current_system_prompt.push_str("\n\n");
                current_system_prompt.push_str(&team_reminder);
            }
        }
        if let Some(active) = &active_run {
            current_system_prompt.push_str("\n\n");
            current_system_prompt.push_str(&system_block(active));
        }
        let current_system_prompt = system_prompt_for_turn(
            &current_system_prompt,
            mode,
            &goal_workflow,
            tool_settings.plan_mode_prompt(),
        );

        if auto_compact {
            match maybe_auto_compact_history(
                &provider,
                &model,
                cache_key.as_ref(),
                &mut cache_stable_message_count,
                service_tier,
                &mut history,
                &mut current_turn_tool_result_ids,
                &current_system_prompt,
                &tool_descriptors,
                &event_tx,
                event_scope.as_ref(),
                &mut cmd_rx,
                &mut auto_compaction_attempts,
            )
            .await
            {
                Ok(true) => {
                    compacted = true;
                    continue;
                }
                Ok(false) => {}
                Err(err) => {
                    measurement.record.status = "error".into();
                    send_event(
                        &event_tx,
                        event_scope.as_ref(),
                        AgentEvent::Error { message: err },
                    );
                    break;
                }
            }
        }

        let request_history =
            history_with_current_tool_result_ids(&history, &current_turn_tool_result_ids);
        let request = ProviderRequest::new(model.clone(), request_history)
            .with_system(current_system_prompt.clone())
            .with_tools(tool_descriptors.clone())
            .with_cache_stable_message_count(cache_stable_message_count);
        let request = match &cache_key {
            Some(cache_key) => request.with_cache_key(cache_key.clone()),
            None => request,
        };
        let request = match service_tier {
            Some(service_tier) => request.with_service_tier(service_tier),
            None => request,
        };

        let mut stream_retry_attempts = 0usize;
        let (message_builder, mut stop_reason, response_usage) = 'stream_attempt: loop {
            let mut stream = match provider.stream(request.clone()).await {
                Ok(stream) => stream,
                Err(err) => {
                    if should_retry_stream(&err, stream_retry_attempts) {
                        stream_retry_attempts += 1;
                        tracing::warn!(
                            provider = provider.name(),
                            attempt = stream_retry_attempts,
                            max_attempts = SAFE_STREAM_MAX_RETRIES,
                            error = %err,
                            "retrying provider stream setup"
                        );
                        tokio::time::sleep(stream_retry_delay(stream_retry_attempts)).await;
                        continue 'stream_attempt;
                    }

                    if auto_compact
                        && is_context_length_error(&err)
                        && can_auto_compact_history(&history, auto_compaction_attempts)
                    {
                        match run_auto_compaction(
                            &provider,
                            &model,
                            cache_key.as_ref(),
                            &mut cache_stable_message_count,
                            service_tier,
                            &mut history,
                            &mut current_turn_tool_result_ids,
                            &current_system_prompt,
                            &event_tx,
                            event_scope.as_ref(),
                            &mut cmd_rx,
                            &mut auto_compaction_attempts,
                        )
                        .await
                        {
                            Ok(()) => {
                                compacted = true;
                                continue 'conversation;
                            }
                            Err(compaction_err) => {
                                measurement.record.status = "error".into();
                                send_event(
                                    &event_tx,
                                    event_scope.as_ref(),
                                    AgentEvent::Error {
                                        message: format!(
                                            "provider error: {err}; context compaction failed: {compaction_err}"
                                        ),
                                    },
                                );
                                break 'conversation;
                            }
                        }
                    }
                    measurement.record.status = "error".into();
                    send_event(
                        &event_tx,
                        event_scope.as_ref(),
                        AgentEvent::Error {
                            message: format!("provider error: {err}"),
                        },
                    );
                    break 'conversation;
                }
            };

            let mut message_builder = AssistantMessageBuilder::default();
            let mut stop_reason = StopReason::EndTurn;
            let mut response_usage = None;
            let mut stream_error = None;
            let mut saw_message_stop = false;
            let mut finalized_tool_calls = 0usize;
            let mut tool_preflights = ToolPreflightRegistry::default();
            let mut preflight_abort: Option<(usize, ToolRunResult)> = None;

            loop {
                tokio::select! {
                    biased;

                    command = cmd_rx.recv() => {
                        if matches!(command, Some(EngineCommand::Cancel)) {
                            cancelled = true;
                            break;
                        }
                    }
                    event = stream.next() => {
                        let Some(event) = event else { break; };
                        let event = match event {
                            Ok(event) => event,
                            Err(err) => {
                                stream_error = Some(err);
                                break;
                            }
                        };

                        if matches!(&event, StreamEvent::TextDelta { delta, .. } | StreamEvent::ThinkingDelta { delta, .. } if !delta.is_empty())
                            || matches!(&event, StreamEvent::ToolJsonDelta { chunk, .. } if !chunk.is_empty()) {
                            measurement.first_token();
                        }
                        match event {
                            StreamEvent::QuotaObservation { observation } => {
                                send_event(&event_tx, event_scope.as_ref(), AgentEvent::QuotaObservation { observation });
                            }
                            StreamEvent::MessageStart { .. } => {}
                            StreamEvent::PartStart { index, kind, tool } => {
                                message_builder.open(index, kind);
                                match kind {
                                    PartKind::Text => { send_event(&event_tx, event_scope.as_ref(), AgentEvent::TextStarted); }
                                    PartKind::Thinking => { send_event(&event_tx, event_scope.as_ref(), AgentEvent::ThinkingStarted); }
                                    PartKind::ToolCall => {
                                        if let Some(tool) = tool {
                                            message_builder.register_tool(index, tool.id.clone(), tool.name.clone());
                                            tool_preflights.start_tool(index, &tool.name);
                                            send_event(&event_tx, event_scope.as_ref(), AgentEvent::ToolStarted { id: tool.id, name: tool.name });
                                        }
                                    }
                                }
                            }
                            StreamEvent::TextDelta { index, delta } => {
                                message_builder.push_text(index, &delta);
                                send_event(&event_tx, event_scope.as_ref(), AgentEvent::TextChunk { delta });
                            }
                            StreamEvent::ThinkingDelta { index, delta } => {
                                message_builder.push_text(index, &delta);
                                send_event(&event_tx, event_scope.as_ref(), AgentEvent::ThinkingChunk { delta });
                            }
                            StreamEvent::ToolJsonDelta { index, chunk } => {
                                message_builder.push_tool_json(index, &chunk);
                                if let Some((id, name)) = message_builder.tool_head(index) {
                                    if should_stream_tool_args(&name) {
                                        send_event(&event_tx, event_scope.as_ref(), AgentEvent::ToolArgsDelta { id: id.clone(), delta: chunk.clone() });
                                    }
                                    if preflight_abort.is_none() {
                                        if let Some(result) = tool_preflights.push_tool_json(
                                            index,
                                            &chunk,
                                            &write_file,
                                            &read_fingerprints,
                                        ) {
                                            preflight_abort = Some((index, result));
                                        }
                                    }
                                }
                                if preflight_abort.is_some() {
                                    break;
                                }
                            }
                            StreamEvent::PartMeta { index, meta } => {
                                message_builder.push_meta(index, meta);
                            }
                            StreamEvent::PartStop { index } => {
                                match message_builder.kind(index) {
                                    Some(PartKind::Text) => { send_event(&event_tx, event_scope.as_ref(), AgentEvent::TextFinished); }
                                    Some(PartKind::Thinking) => {
                                        if let Some(ms) = message_builder.thinking_duration_ms(index) {
                                            message_builder.insert_meta_field(index, "duration_ms", json!(ms));
                                        }
                                        send_event(&event_tx, event_scope.as_ref(), AgentEvent::ThinkingFinished);
                                    }
                                    Some(PartKind::ToolCall) => {
                                        let (id, name, args) = message_builder.finalize_tool(index);
                                        let mcp_label = mcp.tool_label(&name).await;
                                        let summary = mcp_label
                                            .as_ref()
                                            .map(|label| {
                                                format!(
                                                    "{} · {}",
                                                    display_mcp_server_name(&label.server_name),
                                                    label.tool_name
                                                )
                                            })
                                            .or_else(|| {
                                                subagents
                                                    .as_ref()
                                                    .and_then(|tool| tool.summary_for_tool_name(&name))
                                            })
                                            .or_else(|| {
                                                teams
                                                    .as_ref()
                                                    .and_then(|tool| tool.summary_for_tool_name(&name))
                                            })
                                            .unwrap_or_else(|| summarize_tool(&name, &args));
                                        if let Some(label) = mcp_label {
                                            message_builder.insert_meta_field(index, "mcp", json!(label));
                                        }
                                        send_event(&event_tx, event_scope.as_ref(), AgentEvent::ToolReady {
                                            id: id.clone(),
                                            summary,
                                            args_pretty: pretty_json(&args),
                                        });
                                        if should_run_eager_write_file(&name, mode, &tool_settings)
                                            && tool_preflights.failed(index).is_none()
                                            && finalized_tool_calls == 0
                                            && loops < max_tool_rounds
                                            && eager_tool_results.is_empty()
                                        {
                                            let eager_write_file = write_file.clone();
                                            let read_fingerprints = read_fingerprints.clone();
                                            let input = args.clone();
                                            eager_tool_results.insert(
                                                id,
                                                tokio::spawn(async move {
                                                    eager_write_file.run(input, &read_fingerprints).await
                                                }),
                                            );
                                        }
                                        finalized_tool_calls += 1;
                                    }
                                    None => {}
                                }
                            }
                            StreamEvent::Usage { usage } => {
                                response_usage = Some(usage);
                                send_token_usage_event(&event_tx, event_scope.as_ref(), &provider, &model, usage);
                            }
                            StreamEvent::MessageStop { stop_reason: reason, usage } => {
                                saw_message_stop = true;
                                stop_reason = reason;
                                response_usage = Some(usage);
                                send_token_usage_event(&event_tx, event_scope.as_ref(), &provider, &model, usage);
                                break;
                            }
                        }
                    }
                }
            }

            if let Some((index, result)) = &preflight_abort {
                message_builder.insert_meta_field(*index, "preflight_aborted", json!(true));
                message_builder.insert_meta_field(
                    *index,
                    "preflight_error",
                    json!(result.content.clone()),
                );
            }

            // Detect a silent stream close: the underlying SSE source returned `None` (or yielded
            // its last item) without ever emitting a `MessageStop`. This is the classic "OpenAI
            // just stops without an error" symptom — usually a connection drop on the provider /
            // edge proxy side. Surface it as an explicit stream error so the user gets feedback
            // and the normal recovery path (auto-compaction, etc.) is given a chance to run.
            if !cancelled && stream_error.is_none() && !saw_message_stop {
                stream_error = Some(AppError::Stream(format!(
                    "{} stream closed without sending a stop event (likely a connection drop)",
                    provider.name()
                )));
            }

            if let Some((_index, _)) = &preflight_abort {
                abort_eager_tool_results(&mut eager_tool_results);
                stop_reason = StopReason::ToolUse;
                break 'stream_attempt (message_builder, stop_reason, response_usage);
            }

            if let Some(err) = stream_error {
                if !eager_tool_results.is_empty() {
                    tracing::warn!(
                        provider = provider.name(),
                        error = %err,
                        "stream ended after eager tool execution; continuing with completed tool call"
                    );
                    stop_reason = StopReason::ToolUse;
                    break 'stream_attempt (message_builder, stop_reason, response_usage);
                }

                if should_retry_stream(&err, stream_retry_attempts) {
                    stream_retry_attempts += 1;
                    tracing::warn!(
                        provider = provider.name(),
                        attempt = stream_retry_attempts,
                        max_attempts = SAFE_STREAM_MAX_RETRIES,
                        error = %err,
                        "retrying provider stream"
                    );
                    tokio::time::sleep(stream_retry_delay(stream_retry_attempts)).await;
                    continue 'stream_attempt;
                }

                if auto_compact
                    && message_builder.is_empty()
                    && is_context_length_error(&err)
                    && can_auto_compact_history(&history, auto_compaction_attempts)
                {
                    match run_auto_compaction(
                        &provider,
                        &model,
                        cache_key.as_ref(),
                        &mut cache_stable_message_count,
                        service_tier,
                        &mut history,
                        &mut current_turn_tool_result_ids,
                        &current_system_prompt,
                        &event_tx,
                        event_scope.as_ref(),
                        &mut cmd_rx,
                        &mut auto_compaction_attempts,
                    )
                    .await
                    {
                        Ok(()) => {
                            compacted = true;
                            continue 'conversation;
                        }
                        Err(compaction_err) => {
                            measurement.record.status = "error".into();
                            send_event(
                                &event_tx,
                                event_scope.as_ref(),
                                AgentEvent::Error {
                                    message: format!(
                                        "stream error: {err}; context compaction failed: {compaction_err}"
                                    ),
                                },
                            );
                            break 'conversation;
                        }
                    }
                }

                if let Some(usage) = response_usage { measurement.usage(usage); }
                measurement.record.status = "error".into();
                send_event(
                    &event_tx,
                    event_scope.as_ref(),
                    AgentEvent::Error {
                        message: format!("stream error: {err}"),
                    },
                );
                break 'conversation;
            }

            break 'stream_attempt (message_builder, stop_reason, response_usage);
        };

        let mut assistant = message_builder.finish();
        if let Some(usage) = response_usage { measurement.usage(usage); }
        measurement.record.tool_calls += assistant.parts.iter().filter(|p| matches!(p, Part::ToolCall { .. })).count() as u64;
        if cancelled {
            if eager_tool_results.is_empty() {
                retain_cancelled_visible_parts(&mut assistant);
                if !assistant.parts.is_empty() {
                    history.push(assistant);
                }
                break 'conversation;
            }
            retain_cancelled_eager_parts(&mut assistant, &eager_tool_results);
        }
        if mode == AgentMode::Plan && !stop_questions && question_enabled {
            if !assistant_has_question_tool(&assistant)
                && !matches!(stop_reason, StopReason::ToolUse)
            {
                append_plan_fallback_question(&mut assistant, &event_tx, event_scope.as_ref());
                stop_reason = StopReason::ToolUse;
            } else if assistant_has_question_tool(&assistant) {
                stop_reason = StopReason::ToolUse;
            }
        }
        if let Some(usage) = response_usage {
            attach_token_usage(&mut assistant, provider.name(), &model.name, usage);
        }
        // Lot C4: the model wants to end its turn, the guard of the active run decides.
        let mut pending_run_message = None;
        if let (Some(handle), Some(active)) = (&run, active_run.as_mut()) {
            if !cancelled
                && !matches!(stop_reason, StopReason::ToolUse)
                && eager_tool_results.is_empty()
                && matches!(mode, AgentMode::Act | AgentMode::Goal)
                && loops < max_tool_rounds
            {
                let path = run_path(&handle.workspace_root, &handle.conversation_id);
                let verdict = {
                    let judged = advance(active, &handle.workspace_root);
                    tokio::pin!(judged);
                    let outcome = tokio::select! {
                        biased;
                        command = cmd_rx.recv() => Err(command),
                        verdict = &mut judged => Ok(verdict),
                    };
                    match outcome {
                        Ok(verdict) => Some(verdict),
                        Err(Some(EngineCommand::Cancel)) => None,
                        Err(None) => Some(judged.await),
                    }
                };
                match verdict {
                    None => cancelled = true,
                    Some(verdict) => {
                        if let Err(error) = active.save(&path) {
                            tracing::warn!("unable to save run: {error}");
                        }
                        if let Verdict::Next { recovered: Some(recovered), .. }
                        | Verdict::Done { recovered: Some(recovered) } = &verdict
                        {
                            capture_guard_lesson(&database.store(), handle, active, recovered, &step_changed_paths);
                        }
                        pending_run_message = run_guard_message(&verdict, active);
                        match verdict {
                            Verdict::Next { .. } => step_changed_paths.clear(),
                            Verdict::Refused { .. } | Verdict::Done { .. } => {}
                            Verdict::Escalate { guard, reasons } => {
                                if question_enabled {
                                    append_question_call(
                                        &mut assistant,
                                        &event_tx,
                                        event_scope.as_ref(),
                                        format!("{RUN_ARBITRAGE_PREFIX}{}", Uuid::new_v4()),
                                        run_arbitrage_question(&guard, &reasons),
                                    );
                                    stop_reason = StopReason::ToolUse;
                                } else {
                                    active.status = RunStatus::Stopped;
                                    let _ = active.save(&path);
                                    send_event(
                                        &event_tx,
                                        event_scope.as_ref(),
                                        AgentEvent::Error {
                                            message: format!(
                                                "run stopped: guard refused {} times",
                                                crate::run_engine::MAX_REFUSALS
                                            ),
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
        if active_run.as_ref().is_some_and(|active| active.status != RunStatus::Active) {
            active_run = None;
        }
        if cancelled && eager_tool_results.is_empty() {
            if !assistant.parts.is_empty() {
                history.push(assistant);
            }
            break 'conversation;
        }
        if !assistant.parts.is_empty() {
            history.push(assistant.clone());
        }
        if let Some(text) = pending_run_message {
            history.push(ChatMessage {
                role: Role::User,
                parts: vec![Part::Text {
                    text,
                    meta: Some(json!({ "system_reminder": true, "run_guard": true })),
                }],
            });
            loops += 1;
            continue 'conversation;
        }

        if !matches!(stop_reason, StopReason::ToolUse) && !eager_tool_results.is_empty() {
            stop_reason = StopReason::ToolUse;
        }
        if !matches!(stop_reason, StopReason::ToolUse) {
            let todo_guard_tool_available =
                todo_list_tool.is_some() && tool_settings.is_enabled(tool_names::TODO_LIST);
            if should_trigger_todo_final_answer_guard(
                &todo_list,
                todo_guard_tool_available,
                stop_reason,
                &assistant,
                todo_final_answer_guard_attempted,
                loops,
                max_tool_rounds,
            ) {
                todo_final_answer_guard_attempted = true;
                history.push(todo_final_answer_guard_message(&todo_list));
                continue 'conversation;
            }
            break;
        }

        if loops >= max_tool_rounds {
            measurement.record.status = "error".into();
            abort_eager_tool_results(&mut eager_tool_results);
            send_event(
                &event_tx,
                event_scope.as_ref(),
                AgentEvent::Error {
                    message: format!("tool loop limit reached ({max_tool_rounds})"),
                },
            );
            break;
        }
        loops += 1;

        let mut tool_results = Vec::new();
        let mut round_edited = false;
        let batch_end = parallel_batches(&assistant.parts, &tool_settings);
        let mut prefetched = HashMap::<String, ToolRunResult>::new();
        for (part_index, part) in assistant.parts.iter().enumerate() {
            if cancelled {
                break;
            }
            if let Some(&end) = batch_end.get(&part_index) {
                // Lancé ici et pas avant : une lecture après un edit_file doit voir le fichier modifié.
                let calls: Vec<(&String, &String, &Value)> = assistant.parts[part_index..end]
                    .iter()
                    .filter_map(|part| match part {
                        Part::ToolCall {
                            id, name, input, ..
                        } => Some((id, name, input)),
                        _ => None,
                    })
                    .collect();
                let batch = futures_util::future::join_all(calls.iter().map(
                    |(_, name, input)| {
                        run_parallel_safe_tool(
                            &glob,
                            &grep,
                            &read,
                            &web_search,
                            &web_fetch,
                            name,
                            (*input).clone(),
                        )
                    },
                ));
                tokio::pin!(batch);
                let outcome = tokio::select! {
                    biased;
                    command = cmd_rx.recv() => Err(command),
                    results = &mut batch => Ok(results),
                };
                let results = match outcome {
                    Ok(results) => results,
                    Err(Some(EngineCommand::Cancel)) => {
                        cancelled = true;
                        abort_eager_tool_results(&mut eager_tool_results);
                        break;
                    }
                    Err(None) => batch.await,
                };
                for ((id, _, _), result) in calls.iter().zip(results) {
                    prefetched.insert((*id).clone(), result);
                }
            }
            if let Part::ToolCall {
                id, name, input, ..
            } = part
            {
                let result = if let Some(preflight_error) = preflight_error_result(part) {
                    preflight_error
                } else if name == "clean_context" {
                    run_clean_context(&mut history, input.clone(), &current_turn_tool_result_ids)
                } else if name == "update_goal" {
                    // Lot C5: a goal with an active run is complete only when its guard is green.
                    match goal_guard_refusal(run.as_ref(), &mut active_run).await {
                        Some(refusal) => refusal,
                        None => run_update_goal(&mut goal_workflow, input.clone()),
                    }
                } else if let Some(handle) = eager_tool_results.remove(id) {
                    match handle.await {
                        Ok(result) => result,
                        Err(err) => {
                            ToolRunResult::err(format!("write_file task failed: {err}"), Vec::new())
                        }
                    }
                } else if let Some(result) = prefetched.remove(id) {
                    result
                } else if should_wait_for_cooperative_cancel(
                    name,
                    subagents.as_ref(),
                    teams.as_ref(),
                ) {
                    let result = run_tool(
                        &bash,
                        &python,
                        &glob,
                        &grep,
                        &read,
                        &edit_file,
                        &write_file,
                        &create_image,
                        todo_list_tool.as_deref(),
                        question.as_deref(),
                        &web_search,
                        &web_fetch,
                        &skill,
                        &database,
                        &mcp,
                        subagents.as_deref(),
                        teams.as_deref(),
                        &tool_settings,
                        &read_fingerprints,
                        &mut todo_list,
                        mode,
                        &event_tx,
                        event_scope.as_ref(),
                        &cancel,
                        id,
                        name,
                        input.clone(),
                    )
                    .await;
                    if matches!(cmd_rx.try_recv(), Ok(EngineCommand::Cancel)) {
                        cancelled = true;
                        abort_eager_tool_results(&mut eager_tool_results);
                    }
                    result
                } else {
                    tokio::select! {
                    biased;
                        command = cmd_rx.recv() => {
                            if matches!(command, Some(EngineCommand::Cancel)) {
                                cancelled = true;
                                abort_eager_tool_results(&mut eager_tool_results);
                                ToolRunResult::err("tool call interrupted by user", Vec::new())
                            } else {
                                continue;
                            }
                        }
                        result = run_tool(
                            &bash,
                            &python,
                            &glob,
                            &grep,
                            &read,
                            &edit_file,
                            &write_file,
                            &create_image,
                            todo_list_tool.as_deref(),
                            question.as_deref(),
                            &web_search,
                            &web_fetch,
                            &skill,
                            &database,
                            &mcp,
                            subagents.as_deref(),
                            teams.as_deref(),
                            &tool_settings,
                            &read_fingerprints,
                            &mut todo_list,
                            mode,
                            &event_tx,
                            event_scope.as_ref(),
                            &cancel,
                            id,
                            name,
                            input.clone(),
                        ) => result,
                    }
                };
                let canonical_name = tool_names::canonical_tool_name(name);
                if (canonical_name == tool_names::READ
                    || canonical_name == tool_names::EDIT_FILE
                    || canonical_name == tool_names::WRITE_FILE)
                    && !result.is_error
                {
                    update_read_fingerprint_cache(&mut read_fingerprints, result.meta.as_ref());
                }
                if !result.is_error && matches!(canonical_name, tool_names::EDIT_FILE | tool_names::WRITE_FILE) {
                    round_edited = true;
                }
                for change in &result.file_changes {
                    step_changed_paths.insert(change.relative_path.clone());
                }
                if id.starts_with(RUN_ARBITRAGE_PREFIX) {
                    if let (Some(handle), Some(active)) = (&run, active_run.as_mut()) {
                        apply_run_arbitrage(active, result.is_error, result.meta.as_ref());
                        let _ = active.save(&run_path(&handle.workspace_root, &handle.conversation_id));
                    }
                    if active_run.as_ref().is_some_and(|active| active.status != RunStatus::Active) {
                        active_run = None;
                    }
                }
                let result_images = result.images.clone();
                let mut result_content = result.content.clone();
                if canonical_name == tool_names::SKILL
                    && !result.is_error
                    && matches!(mode, AgentMode::Act | AgentMode::Goal)
                {
                    let graph = result.meta.as_ref().and_then(|m| m.get("run_graph")).and_then(Value::as_str);
                    if let (Some(handle), Some(graph)) = (&run, graph) {
                        let store = database.store();
                        start_run_from_graph(
                            handle, &store, &cancel, &event_tx, event_scope.as_ref(), id,
                            Path::new(graph), &mut active_run, &mut result_content,
                        )
                        .await;
                    }
                }
                if let Some(teams) = &teams {
                    teams
                        .record_current_agent_file_changes(name, &result.file_changes)
                        .await;
                }
                let mut meta = Map::new();
                if !result.file_changes.is_empty() {
                    meta.insert("file_changes".into(), json!(result.file_changes.clone()));
                }
                if canonical_name == tool_names::TODO_LIST && !result.is_error {
                    meta.insert("todo_list".into(), json!(&todo_list));
                }
                if let Some(Value::Object(result_meta)) = result.meta.clone() {
                    for (key, value) in result_meta {
                        meta.insert(key, value);
                    }
                }
                let stop_after_question = canonical_name == tool_names::QUESTION
                    && meta
                        .get("question_stop_requested")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    && mode == AgentMode::Plan;
                let result_meta = (!meta.is_empty()).then_some(Value::Object(meta));
                send_event(
                    &event_tx,
                    event_scope.as_ref(),
                    AgentEvent::ToolFinished {
                        id: id.clone(),
                        output: result_content.clone(),
                        is_error: result.is_error,
                        file_changes: result.file_changes.clone(),
                        images: result_images.clone(),
                        meta: result_meta.clone(),
                    },
                );
                if canonical_name != tool_names::CLEAN_CONTEXT {
                    current_turn_tool_result_ids.insert(id.clone());
                }
                tool_results.push(Part::ToolResult {
                    tool_call_id: id.clone(),
                    content: result_content,
                    images: result_images
                        .into_iter()
                        .map(|image| ToolResultImage {
                            media_type: image.media_type,
                            data: if canonical_name == tool_names::CREATE_IMAGE {
                                String::new()
                            } else {
                                image.data
                            },
                            path: image.path,
                        })
                        .collect(),
                    is_error: result.is_error,
                    meta: result_meta,
                });
                if cancelled {
                    break;
                }
                if stop_after_question {
                    break;
                }
            }
        }

        if cancelled {
            abort_eager_tool_results(&mut eager_tool_results);
            append_interrupted_tool_results(&assistant, &mut tool_results);
        }

        if tool_results.is_empty() {
            break;
        }

        // Lot E3: show compile errors right after an edit. One bounded check, never retried.
        if round_edited && !cancelled && active_run.is_none() {
            if let Some((handle, command)) =
                run.as_ref().and_then(|handle| Some((handle, handle.verify_command.clone()?)))
            {
                let guard = Guard::Command { run: command.clone(), timeout_secs: 120 };
                let verdict = crate::run_engine::judge(&guard, &handle.workspace_root, None).await;
                if let Some(text) = post_edit_check_message(&verdict, &command) {
                    tool_results.push(Part::Text {
                        text,
                        meta: Some(json!({ "system_reminder": true, "post_edit_check": true })),
                    });
                }
            }
        }

        let stop_after_question_result = tool_results.iter().any(|part| {
            matches!(part, Part::ToolResult { meta: Some(Value::Object(meta)), .. }
                if meta
                    .get("question_stop_requested")
                    .and_then(Value::as_bool)
                    .unwrap_or(false))
        }) && mode == AgentMode::Plan;
        measurement.record.tool_errors += tool_results.iter().filter(|p| matches!(p, Part::ToolResult { is_error: true, .. })).count() as u64;
        history.push(ChatMessage {
            role: Role::User,
            parts: tool_results,
        });
        if cancelled {
            break 'conversation;
        }
        if stop_after_question_result {
            stop_questions = true;
            history.push(ChatMessage {
                role: Role::User,
                parts: vec![Part::Text {
                    text: "\n\n<plan_mode_control action=\"stop_questions\">\nThe user clicked Send and stop questions. Do not ask more questions in this turn. Produce the complete Markdown plan now and do not implement it.\n</plan_mode_control>".to_string(),
                    meta: Some(json!({ "plan_control": "stop_questions" })),
                }],
            });
            continue 'conversation;
        }
    }

    if cancelled {
        send_event(&event_tx, event_scope.as_ref(), AgentEvent::Interrupted);
    }
    if cancelled { measurement.record.status = "interrupted".into(); }
    let record = measurement.finish();
    let measured_duration = record.duration_ms;
    match tokio::task::spawn_blocking(move || measurement_store.record_model_turn(&record)).await {
        Ok(Ok(())) => {},
        Ok(Err(err)) => tracing::warn!("model measurement persistence failed: {err}"),
        Err(err) => tracing::warn!("model measurement worker failed: {err}"),
    }
    send_event(
        &event_tx,
        event_scope.as_ref(),
        AgentEvent::TurnFinished { duration_ms: Some(measured_duration) },
    );
    todo_list.normalize();
    TurnOutput {
        history,
        todo_list,
        goal_workflow,
        interrupted: cancelled,
        compacted,
    }
}

pub(super) fn should_trigger_todo_final_answer_guard(
    state: &TodoListState,
    todo_tool_available: bool,
    stop_reason: StopReason,
    assistant: &ChatMessage,
    already_attempted: bool,
    tool_loops_used: usize,
    max_tool_rounds: usize,
) -> bool {
    !already_attempted
        && todo_tool_available
        && tool_loops_used < max_tool_rounds
        && matches!(stop_reason, StopReason::EndTurn)
        && todo_list_needs_final_answer_update(state)
        && assistant_has_visible_final_text(assistant)
        && !assistant_has_tool_call(assistant)
}

pub(super) fn todo_final_answer_guard_message(state: &TodoListState) -> ChatMessage {
    ChatMessage {
        role: Role::User,
        parts: vec![Part::Text {
            text: todo_final_answer_guard_prompt(state),
            meta: Some(json!({
                "system_reminder": true,
                "todo_final_answer_guard": true,
            })),
        }],
    }
}

fn todo_final_answer_guard_prompt(state: &TodoListState) -> String {
    let snapshot = state.render_tool_output("Current todo_list before final-answer guard:");
    format!(
        "<todo_final_answer_guard>\n\
You just produced a final answer while todo_list is still active. Before ending, call todo_list now.\n\
\n\
Rules:\n\
- If the work described in your previous answer is complete, mark any remaining tasks done and close the list in the same todo_list call.\n\
- If work is not complete, update task statuses truthfully and leave the list active.\n\
- Do not call unrelated tools for this guard.\n\
- Do not repeat the previous final answer; after the todo_list result, keep any follow-up minimal.\n\
\n\
{snapshot}\n\
</todo_final_answer_guard>"
    )
}

fn todo_list_needs_final_answer_update(state: &TodoListState) -> bool {
    state.active && !state.tasks.is_empty()
}

fn assistant_has_visible_final_text(message: &ChatMessage) -> bool {
    message
        .parts
        .iter()
        .any(|part| matches!(part, Part::Text { text, .. } if !text.trim().is_empty()))
}

fn assistant_has_tool_call(message: &ChatMessage) -> bool {
    message
        .parts
        .iter()
        .any(|part| matches!(part, Part::ToolCall { .. }))
}

pub(super) fn retain_cancelled_eager_parts(
    message: &mut ChatMessage,
    eager_tool_results: &BTreeMap<String, JoinHandle<ToolRunResult>>,
) {
    message.parts.retain(|part| match part {
        Part::Text { text, .. } | Part::Thinking { text, .. } => !text.is_empty(),
        Part::ToolCall { id, .. } => eager_tool_results.contains_key(id),
        _ => false,
    });
}

pub(super) fn retain_cancelled_visible_parts(message: &mut ChatMessage) {
    message.parts.retain(|part| match part {
        Part::Text { text, .. } | Part::Thinking { text, .. } => !text.is_empty(),
        _ => false,
    });
}

/// Indice du premier appel d'un lot -> indice exclusif de fin. Un lot = au moins 2 appels
/// consécutifs, parallélisables, activés, sans approbation.
fn parallel_batches(parts: &[Part], settings: &crate::ToolSettings) -> HashMap<usize, usize> {
    let mut batches = HashMap::new();
    let mut run: Option<(usize, usize, usize)> = None; // (début, fin exclue, nombre d'appels)
    let mut close = |run: &mut Option<(usize, usize, usize)>| {
        if let Some((start, end, count)) = run.take() {
            if count >= 2 {
                batches.insert(start, end);
            }
        }
    };
    for (index, part) in parts.iter().enumerate() {
        let Part::ToolCall { name, .. } = part else {
            continue; // texte et réflexion entre deux appels n'exécutent rien
        };
        let batchable = is_parallel_safe(name)
            && settings.is_enabled(name)
            && !settings.requires_approval(name)
            && preflight_error_result(part).is_none();
        if batchable {
            let entry = run.get_or_insert((index, index, 0));
            entry.1 = index + 1;
            entry.2 += 1;
        } else {
            close(&mut run);
        }
    }
    close(&mut run);
    batches
}

fn should_run_eager_write_file(
    name: &str,
    mode: AgentMode,
    tool_settings: &crate::ToolSettings,
) -> bool {
    name == "write_file"
        && mode != AgentMode::Plan
        && tool_settings.is_enabled(name)
        && !tool_settings.requires_approval(name)
}

fn abort_eager_tool_results(handles: &mut BTreeMap<String, JoinHandle<ToolRunResult>>) {
    for (_, handle) in std::mem::take(handles) {
        handle.abort();
    }
}

fn update_read_fingerprint_cache(
    cache: &mut std::collections::HashMap<String, ReadFingerprint>,
    meta: Option<&serde_json::Value>,
) {
    let Some(meta) = meta else {
        return;
    };
    if let Some(fingerprint) = meta
        .get("read_fingerprint")
        .cloned()
        .and_then(|value| serde_json::from_value::<ReadFingerprint>(value).ok())
    {
        cache.insert(fingerprint.relative_path.clone(), fingerprint);
    }
    if let Some(values) = meta.get("read_fingerprints").and_then(Value::as_array) {
        for fingerprint in values
            .iter()
            .filter_map(|value| serde_json::from_value::<ReadFingerprint>(value.clone()).ok())
        {
            cache.insert(fingerprint.relative_path.clone(), fingerprint);
        }
    }
}

fn should_retry_stream(err: &AppError, attempts: usize) -> bool {
    attempts < SAFE_STREAM_MAX_RETRIES
        && matches!(
            err,
            AppError::Network(_)
                | AppError::Stream(_)
                | AppError::Decode(_)
                | AppError::RetryableStream { .. }
        )
}

fn stream_retry_delay(attempt: usize) -> Duration {
    let exponent = attempt.saturating_sub(1).min(8) as u32;
    let base_ms = 200u64.saturating_mul(2u64.saturating_pow(exponent));
    let jitter = rand::rng().random_range(0.9..1.1);
    Duration::from_millis((base_ms as f64 * jitter) as u64)
}

const ACCEPTED_RUN_GRAPHS: &str = "accepted_run_graphs";

/// Starts a run for a skill's graph.json after user approval; appends the outcome to the tool result.
#[allow(clippy::too_many_arguments)]
async fn start_run_from_graph(
    handle: &RunHandle,
    store: &AppStore,
    cancel: &super::cancel::TurnCancel,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    scope: Option<&AgentEventScope>,
    tool_call_id: &str,
    graph_path: &Path,
    active_run: &mut Option<Run>,
    content: &mut String,
) {
    let (graph, sha) = match std::fs::read(graph_path)
        .map_err(anyhow::Error::from)
        .and_then(|bytes| Graph::parse(&bytes))
    {
        Ok(parsed) => parsed,
        Err(error) => {
            content.push_str(&format!("\n\n[graph.json ignored: {error}]"));
            return;
        }
    };
    if let Some(run) = active_run.as_ref().filter(|run| run.status == RunStatus::Active) {
        content.push_str(&format!("\n\n[a run is already active: {}]", run.id));
        return;
    }
    let mut accepted: Vec<String> = store.load_json_setting(ACCEPTED_RUN_GRAPHS).ok().flatten().unwrap_or_default();
    if !accepted.contains(&sha) {
        let mut detail = String::new();
        for (name, step) in &graph.steps {
            detail.push_str(&format!("step {name} (guard {})\n", step.guard));
        }
        for (name, guard) in &graph.guards {
            if let Guard::Command { run, .. } = guard {
                detail.push_str(&format!("guard {name} runs: {run}\n"));
            }
        }
        if !super::approval::request_approval(cancel, event_tx, scope, tool_call_id, "run_graph", detail).await {
            content.push_str("\n\n[run not started: graph not approved]");
            return;
        }
        accepted.push(sha.clone());
        let _ = store.save_json_setting(ACCEPTED_RUN_GRAPHS, &accepted);
    }
    let graph_dir = graph_path.parent().unwrap_or(graph_path).display().to_string();
    let mut run = Run::new(graph, sha, graph_dir, head_commit(&handle.workspace_root));
    let verdict = advance(&mut run, &handle.workspace_root).await;
    // A fresh step failing its guard is work to do, not a refusal.
    if matches!(verdict, Verdict::Refused { .. }) {
        run.refusals.clear();
        run.last_reasons.clear();
    }
    if let Err(error) = run.save(&run_path(&handle.workspace_root, &handle.conversation_id)) {
        content.push_str(&format!("\n\n[run not started: {error}]"));
        return;
    }
    if run.status == RunStatus::Done {
        content.push_str("\n\n[run already complete]");
    } else {
        match step_instruction(&run) {
            Ok(text) => content.push_str(&format!("\n\n<run_step name=\"{}\">\n{text}\n</run_step>", run.step)),
            Err(error) => content.push_str(&format!("\n\n[run step unreadable: {error}]")),
        }
        *active_run = Some(run);
    }
}

const RUN_ARBITRAGE_PREFIX: &str = "run-arbitrage-";

/// Lot E3: nothing when the check passes, a tagged block with the reasons when it fails.
pub(super) fn post_edit_check_message(verdict: &crate::run_engine::GuardVerdict, command: &str) -> Option<String> {
    match verdict {
        crate::run_engine::GuardVerdict::Pass => None,
        crate::run_engine::GuardVerdict::Fail(reasons) => Some(format!(
            "<post_edit_check command=\"{command}\">\n{}\n</post_edit_check>",
            reasons.join("\n")
        )),
    }
}

/// Text sent back to the model after a guard verdict; `None` when the turn may end.
/// The full step instruction is repeated on the first refusal only.
pub(super) fn run_guard_message(verdict: &Verdict, run: &Run) -> Option<String> {
    let instruction = || step_instruction(run).unwrap_or_default();
    match verdict {
        Verdict::Next { step, .. } => Some(format!(
            "The previous step passed its guard. Next step of the run:\n\n<run_step name=\"{step}\">\n{}\n</run_step>",
            instruction()
        )),
        Verdict::Refused { guard, reasons, count } => {
            let mut text = format!(
                "You cannot end this turn yet: guard `{guard}` of run step `{}` refused ({count}/{}):\n- {}",
                run.step,
                crate::run_engine::MAX_REFUSALS,
                reasons.join("\n- ")
            );
            if *count == 1 {
                let instruction = instruction();
                if !instruction.is_empty() {
                    text.push_str(&format!("\n\n<run_step name=\"{}\">\n{instruction}\n</run_step>", run.step));
                }
            }
            text.push_str("\n\nFix this, then end your turn again: the guard is checked on disk, not on your word.");
            Some(text)
        }
        Verdict::Escalate { .. } | Verdict::Done { .. } => None,
    }
}

fn run_arbitrage_question(guard: &str, reasons: &[String]) -> Value {
    let reason: String = reasons.first().map(String::as_str).unwrap_or("").chars().take(300).collect();
    json!({
        "question": format!(
            "La garde {guard} a refusé {} fois : {reason}. Que faire ?",
            crate::run_engine::MAX_REFUSALS
        ),
        "type": "single_choice",
        "options": [{ "label": "Arrêter" }, { "label": "Reprendre" }]
    })
}

/// Answer to the arbitrage question: stop the run, retry, or retry with the user's note.
/// A dismissed question stops the run.
pub(super) fn apply_run_arbitrage(run: &mut Run, is_error: bool, meta: Option<&Value>) {
    let answer = meta
        .and_then(|meta| meta.get("question_answers"))
        .and_then(|answers| answers.get(0))
        .and_then(|first| first.get(0))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|answer| !answer.is_empty());
    let guard = run.graph.steps.get(&run.step).map(|step| step.guard.clone()).unwrap_or_default();
    match answer {
        Some(answer) if !is_error && answer != "Arrêter" => {
            run.refusals.insert(guard, 0);
            if answer != "Reprendre" {
                run.human_note = Some(answer.to_string());
            }
        }
        _ => run.status = RunStatus::Stopped,
    }
}

/// Lot C5: `Some(error result)` while the active run is not done.
async fn goal_guard_refusal(handle: Option<&RunHandle>, active_run: &mut Option<Run>) -> Option<ToolRunResult> {
    let (handle, active) = (handle?, active_run.as_mut()?);
    let verdict = advance(active, &handle.workspace_root).await;
    let _ = active.save(&run_path(&handle.workspace_root, &handle.conversation_id));
    let refusal = match verdict {
        Verdict::Done { .. } => None,
        Verdict::Next { step, .. } => Some(format!("goal is not complete: the run is now at step `{step}`")),
        Verdict::Refused { guard, reasons, .. } | Verdict::Escalate { guard, reasons } => Some(format!(
            "goal is not complete: guard `{guard}` refused: {}",
            reasons.join("; ")
        )),
    };
    if refusal.is_none() {
        *active_run = None;
    }
    refusal.map(|message| ToolRunResult::err(message, Vec::new()))
}

/// Lot D3: an error fixed in front of a guard leaves a sourced candidate lesson, without any
/// model call. A refused insertion (duplicate, learning off) never fails the turn.
fn capture_guard_lesson(
    store: &AppStore,
    handle: &RunHandle,
    run: &Run,
    recovered: &Recovered,
    changed_paths: &BTreeSet<String>,
) {
    if !store.learning_enabled_for(&handle.conversation_id) {
        return;
    }
    let reasons = recovered.reasons.join("; ");
    let first_line: String = reasons.lines().next().unwrap_or("").chars().take(120).collect();
    let paths = changed_paths.iter().take(10).cloned().collect::<Vec<_>>().join(", ");
    let paths = if paths.is_empty() { "(no tracked file change)".to_string() } else { paths };
    let lesson = crate::lessons::NewLesson {
        title: format!("Garde {} : {first_line}", recovered.guard),
        content: format!("Refus : {reasons}. Corrigé en modifiant : {paths}."),
        source_kind: "guard_refusal".into(),
        evidence: format!("{reasons}\n--- passed after {} refusal(s); files: {paths}", recovered.refusals),
        tags: run.graph.tags.clone(),
        run_id: Some(run.id.clone()),
        conversation_id: Some(handle.conversation_id.clone()),
    };
    if let Err(error) = store.insert_lesson(lesson) {
        tracing::warn!("guard lesson not saved: {error}");
    }
}

fn append_plan_fallback_question(
    message: &mut ChatMessage,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    event_scope: Option<&AgentEventScope>,
) {
    let id = format!("plan-question-{}", Uuid::new_v4());
    let input = json!({
        "question": "Je peux continuer a preparer le plan. Tu veux ajouter une contrainte avant que je le cree ?",
        "type": "single_choice",
        "options": [
            {
                "label": "Ajouter une contrainte",
                "description": "Je precise le scope, le gameplay, le style ou les priorites."
            },
            {
                "label": "Creer le plan maintenant",
                "description": "Je suis pret a generer le plan."
            }
        ]
    });

    append_question_call(message, event_tx, event_scope, id, input);
}

/// Adds a synthetic `question` tool call to the assistant message, announced like a real one.
fn append_question_call(
    message: &mut ChatMessage,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    event_scope: Option<&AgentEventScope>,
    id: String,
    input: Value,
) {
    let name = tool_names::QUESTION.to_string();
    send_event(
        event_tx,
        event_scope,
        AgentEvent::ToolStarted {
            id: id.clone(),
            name: name.clone(),
        },
    );
    send_event(
        event_tx,
        event_scope,
        AgentEvent::ToolReady {
            id: id.clone(),
            summary: summarize_tool(&name, &input),
            args_pretty: pretty_json(&input),
        },
    );

    message.parts.push(Part::ToolCall {
        id,
        name,
        input,
        meta: None,
    });
}

fn assistant_has_question_tool(message: &ChatMessage) -> bool {
    message.parts.iter().any(|part| {
        matches!(
            part,
            Part::ToolCall { name, .. } if tool_names::is_tool_name(name, tool_names::QUESTION)
        )
    })
}

#[cfg(test)]
mod run_start_tests {
    use super::*;

    #[tokio::test]
    async fn accepted_graph_starts_run() {
        let base = std::env::temp_dir().join(format!("claakecode-c3-{}", Uuid::new_v4()));
        let skill = base.join("skill");
        std::fs::create_dir_all(skill.join("steps")).unwrap();
        std::fs::write(skill.join("steps/a.md"), "Do A").unwrap();
        let graph = br#"{"start":"a","steps":{"a":{"instructions":["steps/a.md"],"guard":"g","next":null}},"guards":{"g":{"type":"command","run":"false","timeoutSecs":5}}}"#;
        std::fs::write(skill.join("graph.json"), graph).unwrap();
        let (_, sha) = Graph::parse(graph).unwrap();
        let store = AppStore::in_memory().unwrap();
        store.save_json_setting(ACCEPTED_RUN_GRAPHS, &vec![sha]).unwrap();
        let handle = RunHandle { workspace_root: base.clone(), conversation_id: "c1".into(), verify_command: None };
        let (tx, _rx) = mpsc::unbounded_channel();
        let (mut active, mut content) = (None, String::from("Loaded"));
        start_run_from_graph(
            &handle, &store, &super::super::cancel::TurnCancel::empty(), &tx, None, "t1",
            &skill.join("graph.json"), &mut active, &mut content,
        )
        .await;
        assert!(content.contains("<run_step"), "{content}");
        assert!(run_path(&base, "c1").is_file());
        assert!(active.is_some());
        std::fs::remove_dir_all(&base).ok();
    }
}

#[cfg(test)]
mod parallel_tests {
    use super::*;

    fn call(name: &str) -> Part {
        Part::ToolCall {
            id: format!("id-{name}"),
            name: name.to_string(),
            input: json!({}),
            meta: None,
        }
    }

    #[test]
    fn parallel_batches_groups_consecutive_reads() {
        let parts = [call("read"), call("read"), call("edit_file"), call("read"), call("grep")];
        let batches = parallel_batches(&parts, &crate::ToolSettings::default());
        assert_eq!(batches, HashMap::from([(0, 2), (3, 5)]));
    }

    #[test]
    fn parallel_batches_ignores_lone_reads() {
        let parts = [call("read"), call("edit_file"), call("read")];
        assert!(parallel_batches(&parts, &crate::ToolSettings::default()).is_empty());
    }

    #[test]
    fn parallel_batches_excludes_tools_requiring_approval() {
        let settings: crate::ToolSettings =
            serde_json::from_str(r#"{"tools":[{"name":"grep","requireApproval":true}]}"#).unwrap();
        let parts = [call("read"), call("grep"), call("read"), call("glob")];
        assert_eq!(parallel_batches(&parts, &settings), HashMap::from([(2, 4)]));
    }
}
