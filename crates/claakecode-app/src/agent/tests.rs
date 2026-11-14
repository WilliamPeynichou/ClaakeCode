use std::collections::BTreeSet;

use serde_json::json;

use claakecode_core::{ChatMessage, Part, Role, StopReason};

use crate::{TodoListState, TodoStatus, TodoTask};

use super::{
    clean_context::{run_clean_context, tool_result_cleaned, CLEAN_CONTEXT_RESULT_PLACEHOLDER},
    history::{
        history_with_current_tool_result_ids, normalize_tool_call_inputs,
        strip_all_visible_tool_result_ids, tool_result_content_with_id, tool_result_exposes_id,
    },
    turn::{
        retain_cancelled_visible_parts, should_trigger_todo_final_answer_guard,
        todo_final_answer_guard_message,
    },
};

#[test]
fn cancelled_visible_parts_keep_partial_text_only() {
    let mut message = ChatMessage {
        role: Role::Assistant,
        parts: vec![
            Part::Text {
                text: "partial answer".to_string(),
                meta: None,
            },
            Part::Thinking {
                text: "partial thought".to_string(),
                meta: None,
            },
            Part::Text {
                text: String::new(),
                meta: None,
            },
            Part::ToolCall {
                id: "call-1".to_string(),
                name: "read".to_string(),
                input: json!({ "path": "Cargo.toml" }),
                meta: None,
            },
        ],
    };

    retain_cancelled_visible_parts(&mut message);

    assert_eq!(message.parts.len(), 2);
    assert!(matches!(&message.parts[0], Part::Text { text, .. } if text == "partial answer"));
    assert!(matches!(&message.parts[1], Part::Thinking { text, .. } if text == "partial thought"));
}

#[test]
fn todo_final_answer_guard_triggers_for_active_list_and_final_text() {
    let state = active_todo_state();
    let assistant = ChatMessage::assistant_text("C'est termine ✅");

    assert!(should_trigger_todo_final_answer_guard(
        &state,
        true,
        StopReason::EndTurn,
        &assistant,
        false,
        0,
        8,
    ));
}

#[test]
fn todo_final_answer_guard_does_not_trigger_when_unavailable_or_already_attempted() {
    let state = active_todo_state();
    let assistant = ChatMessage::assistant_text("C'est termine ✅");

    assert!(!should_trigger_todo_final_answer_guard(
        &state,
        false,
        StopReason::EndTurn,
        &assistant,
        false,
        0,
        8,
    ));
    assert!(!should_trigger_todo_final_answer_guard(
        &state,
        true,
        StopReason::EndTurn,
        &assistant,
        true,
        0,
        8,
    ));
}

#[test]
fn todo_final_answer_guard_does_not_trigger_for_tool_use_or_closed_list() {
    let assistant = ChatMessage::assistant_text("Je vais mettre a jour la liste.");

    assert!(!should_trigger_todo_final_answer_guard(
        &active_todo_state(),
        true,
        StopReason::ToolUse,
        &assistant,
        false,
        0,
        8,
    ));
    assert!(!should_trigger_todo_final_answer_guard(
        &TodoListState::default(),
        true,
        StopReason::EndTurn,
        &assistant,
        false,
        0,
        8,
    ));
}

#[test]
fn todo_final_answer_guard_message_is_hidden_system_reminder() {
    let message = todo_final_answer_guard_message(&active_todo_state());
    assert_eq!(message.role, Role::User);
    let [Part::Text { text, meta }] = message.parts.as_slice() else {
        panic!("expected a single text part");
    };

    assert!(text.contains("<todo_final_answer_guard>"));
    assert!(text.contains("call todo_list now"));
    assert!(text.contains("1. [in_progress] Build + deploy"));
    assert_eq!(
        meta.as_ref()
            .and_then(|value| value.get("system_reminder"))
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        meta.as_ref()
            .and_then(|value| value.get("todo_final_answer_guard"))
            .and_then(|value| value.as_bool()),
        Some(true)
    );
}

fn active_todo_state() -> TodoListState {
    TodoListState {
        active: true,
        tasks: vec![TodoTask {
            id: "1".to_string(),
            text: "Build + deploy".to_string(),
            status: TodoStatus::InProgress,
        }],
        next_id: 2,
    }
}

#[test]
fn clean_context_replaces_matching_tool_results() {
    let mut history = vec![ChatMessage {
        role: Role::User,
        parts: vec![
            Part::ToolResult {
                tool_call_id: "call-1".to_string(),
                content: "noisy grep output".to_string(),
                images: Vec::new(),
                is_error: false,
                meta: None,
            },
            Part::ToolResult {
                tool_call_id: "call-2".to_string(),
                content: "useful read output".to_string(),
                images: Vec::new(),
                is_error: false,
                meta: None,
            },
        ],
    }];

    let result = run_clean_context(
        &mut history,
        json!({ "tool_call_ids": ["call-1", "missing"] }),
        &BTreeSet::from(["call-1".to_string()]),
    );

    assert!(!result.is_error);
    assert!(result.content.contains("cleaned: 1"));
    let Part::ToolResult { content, meta, .. } = &history[0].parts[0] else {
        panic!("expected tool result");
    };
    assert_eq!(content, CLEAN_CONTEXT_RESULT_PLACEHOLDER);
    assert!(tool_result_cleaned(meta));

    let Part::ToolResult { content, .. } = &history[0].parts[1] else {
        panic!("expected tool result");
    };
    assert_eq!(content, "useful read output");
}

#[test]
fn clean_context_ignores_ids_outside_current_turn() {
    let mut history = vec![ChatMessage {
        role: Role::User,
        parts: vec![Part::ToolResult {
            tool_call_id: "old-call".to_string(),
            content: "old useful output".to_string(),
            images: Vec::new(),
            is_error: false,
            meta: None,
        }],
    }];

    let result = run_clean_context(
        &mut history,
        json!({ "tool_call_ids": ["old-call"] }),
        &BTreeSet::new(),
    );

    assert!(!result.is_error);
    assert!(result.content.contains("cleaned: 0"));
    assert!(result.content.contains("requested: 1"));
    let Part::ToolResult { content, meta, .. } = &history[0].parts[0] else {
        panic!("expected tool result");
    };
    assert_eq!(content, "old useful output");
    assert!(!tool_result_cleaned(meta));
}

#[test]
fn tool_result_content_exposes_tool_call_id() {
    assert_eq!(
        tool_result_content_with_id("call-1", "hello"),
        "tool_call_id: call-1\nhello"
    );
}

#[test]
fn request_history_exposes_only_current_turn_tool_result_ids() {
    let history = vec![ChatMessage {
        role: Role::User,
        parts: vec![
            Part::ToolResult {
                tool_call_id: "call-1".to_string(),
                content: "current result".to_string(),
                images: Vec::new(),
                is_error: false,
                meta: None,
            },
            Part::ToolResult {
                tool_call_id: "call-2".to_string(),
                content: "old result".to_string(),
                images: Vec::new(),
                is_error: false,
                meta: None,
            },
        ],
    }];
    let ids = BTreeSet::from(["call-1".to_string()]);

    let request_history = history_with_current_tool_result_ids(&history, &ids);
    let Part::ToolResult {
        content: current_content,
        ..
    } = &request_history[0].parts[0]
    else {
        panic!("expected tool result");
    };
    let Part::ToolResult {
        content: old_content,
        ..
    } = &request_history[0].parts[1]
    else {
        panic!("expected tool result");
    };

    assert!(tool_result_exposes_id(current_content));
    assert!(!tool_result_exposes_id(old_content));
    let Part::ToolResult { content, .. } = &history[0].parts[0] else {
        panic!("expected tool result");
    };
    assert!(!tool_result_exposes_id(content));
}

#[test]
fn legacy_visible_tool_result_ids_are_stripped_from_history() {
    let mut history = vec![ChatMessage {
        role: Role::User,
        parts: vec![Part::ToolResult {
            tool_call_id: "call-1".to_string(),
            content: "tool_call_id: call-1\nhello".to_string(),
            images: Vec::new(),
            is_error: false,
            meta: None,
        }],
    }];

    strip_all_visible_tool_result_ids(&mut history);

    let Part::ToolResult { content, .. } = &history[0].parts[0] else {
        panic!("expected tool result");
    };
    assert_eq!(content, "hello");
}

#[test]
fn tool_call_inputs_are_normalized_for_provider_replay() {
    let mut history = vec![ChatMessage {
        role: Role::Assistant,
        parts: vec![
            Part::ToolCall {
                id: "call-empty".to_string(),
                name: "TeamStop".to_string(),
                input: json!(""),
                meta: None,
            },
            Part::ToolCall {
                id: "call-json".to_string(),
                name: "TeamStop".to_string(),
                input: json!("{\"agent\":\"ui\"}"),
                meta: None,
            },
            Part::ToolCall {
                id: "call-string".to_string(),
                name: "bash".to_string(),
                input: json!("ls"),
                meta: None,
            },
        ],
    }];

    normalize_tool_call_inputs(&mut history);

    let Part::ToolCall {
        input: empty_input, ..
    } = &history[0].parts[0]
    else {
        panic!("expected tool call");
    };
    let Part::ToolCall {
        input: json_input, ..
    } = &history[0].parts[1]
    else {
        panic!("expected tool call");
    };
    let Part::ToolCall {
        input: string_input,
        ..
    } = &history[0].parts[2]
    else {
        panic!("expected tool call");
    };

    assert_eq!(empty_input, &json!({}));
    assert_eq!(json_input, &json!({ "agent": "ui" }));
    assert_eq!(string_input, &json!({ "value": "ls" }));
}

// --- Lots C4, C5, D3: the real loop with a scripted provider ---

mod run_loop {
    use serde_json::json;

    use claakecode_core::{Part, Role};

    use crate::agent::test_support::{test_turn_context, text_response, tool_response, ScriptedProvider};
    use crate::agent::turn::{apply_run_arbitrage, run_guard_message};
    use crate::agent::{run_turn, AgentMode, RunHandle};
    use crate::run_engine::{run_path, Graph, Run, RunStatus, Verdict};
    use crate::store::GoalWorkflowState;

    const GRAPH: &str = r#"{"start":"only","steps":{"only":{"guard":"g"}},
        "guards":{"g":{"type":"command","run":"test -f done.txt || { echo 'done.txt is missing'; exit 1; }","timeoutSecs":20}}}"#;

    fn workspace_with_run(name: &str) -> (std::path::PathBuf, RunHandle) {
        let root = std::env::temp_dir().join(format!("claakecode-run-loop-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let (graph, sha) = Graph::parse(GRAPH.as_bytes()).unwrap();
        let run = Run::new(graph, sha, root.display().to_string(), None);
        run.save(&run_path(&root, "c1")).unwrap();
        (root.clone(), RunHandle { workspace_root: root, conversation_id: "c1".into(), verify_command: None })
    }

    fn is_run_guard(message: &claakecode_core::ChatMessage) -> bool {
        message.role == Role::User
            && message.parts.iter().any(|part| {
                matches!(part, Part::Text { meta: Some(meta), .. } if meta.get("run_guard").is_some())
            })
    }

    #[tokio::test]
    async fn guard_refuses_end_of_turn_until_file_exists() {
        let (root, handle) = workspace_with_run("c4");
        let provider = ScriptedProvider::new(vec![
            text_response("All done."),
            tool_response("w1", "write_file", json!({ "path": "done.txt", "content": "ok" })),
            text_response("Now it is done."),
        ]);
        let (mut context, _events, store) = test_turn_context(provider.clone(), &root);
        context.run = Some(handle);

        let output = run_turn(context).await;

        assert_eq!(provider.call_count(), 3);
        // user, assistant "All done.", run_guard reminder, ...
        assert!(is_run_guard(&output.history[2]), "{:?}", output.history[2]);
        assert_eq!(output.history.iter().filter(|m| is_run_guard(m)).count(), 1);
        assert!(root.join("done.txt").is_file());
        let run = Run::load(&run_path(&root, "c1")).unwrap().unwrap();
        assert_eq!(run.status, RunStatus::Done);
        // Lot D3: one sourced candidate lesson for the refusal that was fixed.
        let lessons = store.list_lessons(None).unwrap();
        assert_eq!(lessons.len(), 1, "{lessons:?}");
        assert_eq!(lessons[0].status, "candidate");
        assert_eq!(lessons[0].source_kind, "guard_refusal");
        assert!(lessons[0].evidence.contains("passed after 1 refusal(s)"));
        assert!(lessons[0].content.contains("done.txt"));
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn learning_off_captures_no_lesson() {
        let (root, handle) = workspace_with_run("d3-off");
        let provider = ScriptedProvider::new(vec![
            text_response("All done."),
            tool_response("w1", "write_file", json!({ "path": "done.txt", "content": "ok" })),
            text_response("Now it is done."),
        ]);
        let (mut context, _events, store) = test_turn_context(provider, &root);
        context.run = Some(handle);
        store.set_learning_enabled(false).unwrap();
        run_turn(context).await;
        assert!(store.list_lessons(None).unwrap().is_empty());
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn run_stops_after_max_refusals_without_question_tool() {
        let (root, handle) = workspace_with_run("c4-stop");
        let provider = ScriptedProvider::new(Vec::new());
        let (mut context, _events, _store) = test_turn_context(provider.clone(), &root);
        context.run = Some(handle);
        run_turn(context).await;
        assert_eq!(provider.call_count(), crate::run_engine::MAX_REFUSALS as usize);
        let run = Run::load(&run_path(&root, "c1")).unwrap().unwrap();
        assert_eq!(run.status, RunStatus::Stopped);
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn plan_mode_never_judges_the_run() {
        let (root, handle) = workspace_with_run("c4-plan");
        let provider = ScriptedProvider::new(vec![text_response("A plan.")]);
        let (mut context, _events, _store) = test_turn_context(provider.clone(), &root);
        context.run = Some(handle);
        context.mode = AgentMode::Plan;
        let output = run_turn(context).await;
        assert_eq!(provider.call_count(), 1);
        assert!(!output.history.iter().any(is_run_guard));
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn update_goal_is_refused_while_guard_is_red() {
        let (root, handle) = workspace_with_run("c5");
        let provider = ScriptedProvider::new(vec![
            tool_response("g1", "update_goal", json!({ "status": "complete", "summary": "done" })),
            text_response("Finished."),
        ]);
        let (mut context, _events, _store) = test_turn_context(provider, &root);
        context.run = Some(handle);
        context.mode = AgentMode::Goal;
        context.max_tool_rounds = 1;
        context.goal_workflow =
            GoalWorkflowState::Active { objective: "x".into(), started_at_ms: 1, updated_at_ms: 1 };

        let output = run_turn(context).await;

        let refused = output.history.iter().flat_map(|m| m.parts.iter()).any(|part| {
            matches!(part, Part::ToolResult { is_error: true, content, .. } if content.contains("goal is not complete"))
        });
        assert!(refused, "{:?}", output.history);
        assert!(matches!(output.goal_workflow, GoalWorkflowState::Active { .. }));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn guard_message_repeats_instruction_on_first_refusal_only() {
        let dir = std::env::temp_dir().join(format!("claakecode-guard-msg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "INSTRUCTION-A").unwrap();
        let graph = r#"{"start":"only","steps":{"only":{"instructions":["a.md"],"guard":"g"}},
            "guards":{"g":{"type":"command","run":"test -f x"}}}"#;
        let (graph, sha) = Graph::parse(graph.as_bytes()).unwrap();
        let run = Run::new(graph, sha, dir.display().to_string(), None);
        let refused = |count| Verdict::Refused { guard: "g".into(), reasons: vec!["missing file x".into()], count };
        let first = run_guard_message(&refused(1), &run).unwrap();
        assert!(first.contains("missing file x") && first.contains("INSTRUCTION-A"));
        let second = run_guard_message(&refused(2), &run).unwrap();
        assert!(second.contains("missing file x") && !second.contains("INSTRUCTION-A"));
        assert!(run_guard_message(&Verdict::Done { recovered: None }, &run).is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    /// Lot E2: a delegated step goes to its sub-agent, not to the main model. Here the
    /// sub-agent cannot run (scripted model has no capabilities), so the guard stays red and the
    /// loop must end after the usual 5 refusals instead of spinning.
    #[tokio::test]
    async fn delegated_step_is_bounded_when_the_sub_agent_fails() {
        use crate::agent::AgentEvent;
        use crate::subagent::{SubAgentConfig, SubAgentSettings};
        let root = std::env::temp_dir().join(format!("claakecode-run-loop-e2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let graph = r#"{"start":"only","steps":{"only":{"guard":"g","profile":"reviewer"}},
            "guards":{"g":{"type":"command","run":"test -f done.txt"}}}"#;
        let (graph, sha) = Graph::parse(graph.as_bytes()).unwrap();
        Run::new(graph, sha, root.display().to_string(), None).save(&run_path(&root, "c1")).unwrap();

        let provider = ScriptedProvider::new(vec![text_response("All done.")]);
        let (mut context, mut events, store) = test_turn_context(provider.clone(), &root);
        let reviewer: SubAgentConfig = serde_json::from_value(json!({
            "id": "reviewer", "name": "Reviewer", "description": "d", "prompt": "p",
            "model": { "provider": "scripted", "name": "scripted" }
        }))
        .unwrap();
        let mut providers = std::collections::HashMap::new();
        providers.insert("scripted".to_string(), provider.clone() as std::sync::Arc<dyn claakecode_core::Provider>);
        context.subagents = Some(std::sync::Arc::new(crate::SubAgentTool::new(
            root.clone(),
            String::new(),
            providers,
            claakecode_core::ModelRef::new("other", "other"),
            SubAgentSettings { agents: vec![reviewer], ..Default::default() },
            Default::default(),
            Default::default(),
            Default::default(),
            crate::DatabaseTool::new(store),
            5,
            None,
            context.cancel.clone(),
        )));
        context.run = Some(RunHandle { workspace_root: root.clone(), conversation_id: "c1".into(), verify_command: None });

        run_turn(context).await;

        assert_eq!(provider.call_count(), 1, "the main model must not be asked to do the delegated step");
        let mut delegated = 0;
        while let Ok(event) = events.try_recv() {
            if matches!(&event, AgentEvent::ToolFinished { id, .. } if id.starts_with("run-step-")) {
                delegated += 1;
            }
        }
        assert_eq!(delegated, crate::run_engine::MAX_REFUSALS as usize);
        assert_eq!(Run::load(&run_path(&root, "c1")).unwrap().unwrap().status, RunStatus::Stopped);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn post_edit_check_message_only_on_failure() {
        use crate::agent::turn::post_edit_check_message;
        use crate::run_engine::GuardVerdict;
        assert!(post_edit_check_message(&GuardVerdict::Pass, "cargo check").is_none());
        let text = post_edit_check_message(&GuardVerdict::Fail(vec!["error[E0425]".into()]), "cargo check").unwrap();
        assert!(text.starts_with("<post_edit_check command=\"cargo check\">") && text.contains("error[E0425]"));
    }

    #[tokio::test]
    async fn failing_post_edit_check_is_shown_to_the_model() {
        let root = std::env::temp_dir().join(format!("claakecode-post-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let provider = ScriptedProvider::new(vec![
            tool_response("w1", "write_file", json!({ "path": "a.txt", "content": "x" })),
            text_response("Done."),
        ]);
        let (mut context, _events, _store) = test_turn_context(provider, &root);
        context.run = Some(RunHandle {
            workspace_root: root.clone(),
            conversation_id: "c1".into(),
            verify_command: Some("echo BROKEN-BUILD; exit 1".into()),
        });
        let output = run_turn(context).await;
        let shown = output.history.iter().flat_map(|m| m.parts.iter()).any(|part| {
            matches!(part, Part::Text { text, .. } if text.contains("<post_edit_check") && text.contains("BROKEN-BUILD"))
        });
        assert!(shown, "{:?}", output.history);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn arbitrage_answer_stops_retries_or_adds_a_note() {
        let (graph, sha) = Graph::parse(GRAPH.as_bytes()).unwrap();
        let fresh = || {
            let mut run = Run::new(graph.clone(), sha.clone(), ".".into(), None);
            run.refusals.insert("g".into(), 5);
            run
        };
        let answer = |text: &str| json!({ "question_answers": [[text]] });

        let mut run = fresh();
        apply_run_arbitrage(&mut run, false, Some(&answer("Reprendre")));
        assert_eq!((run.status, run.refusals["g"], run.human_note.clone()), (RunStatus::Active, 0, None));

        let mut run = fresh();
        apply_run_arbitrage(&mut run, false, Some(&answer("Utilise le dossier out/")));
        assert_eq!(run.human_note.as_deref(), Some("Utilise le dossier out/"));
        assert_eq!(run.refusals["g"], 0);

        let mut run = fresh();
        apply_run_arbitrage(&mut run, false, Some(&answer("Arrêter")));
        assert_eq!(run.status, RunStatus::Stopped);

        let mut run = fresh();
        apply_run_arbitrage(&mut run, true, None);
        assert_eq!(run.status, RunStatus::Stopped);
    }
}
