use super::*;

#[test]
fn optional_object_tools_accept_empty_string_input() {
    let status: TeamNameInput = serde_json::from_value(normalize_optional_object_input(json!("")))
        .expect("empty status input should parse as an empty object");
    let stop: TeamStopInput = serde_json::from_value(normalize_optional_object_input(json!("  ")))
        .expect("empty stop input should parse as an empty object");

    assert_eq!(status.team_name, None);
    assert_eq!(stop.team_name, None);
    assert_eq!(stop.agent, None);
}

#[test]
fn optional_object_tools_accept_json_string_input() {
    let stop: TeamStopInput =
        serde_json::from_value(normalize_optional_object_input(json!("{\"agent\":\"ui\"}")))
            .expect("json string stop input should parse as an object");

    assert_eq!(stop.agent.as_deref(), Some("ui"));
}

#[tokio::test]
async fn team_stop_without_active_team_is_noop() {
    let tool = test_team_tool();
    let (event_tx, _event_rx) = mpsc::unbounded_channel();

    let result = tool.run_stop(json!(""), event_tx).await;

    assert!(!result.is_error);
    assert!(result.content.contains("no active Agent Swarm"));
}

#[tokio::test]
async fn team_status_without_active_team_is_noop() {
    let tool = test_team_tool();

    let result = tool.run_status(json!("")).await;

    assert!(!result.is_error);
    assert!(result.content.contains("no active Agent Swarm"));
}

#[tokio::test]
async fn team_stop_all_removes_active_runtime_team() {
    let tool = test_team_tool();
    {
        let mut runtime = tool.runtime.write().await;
        let scope = runtime.scopes.entry(tool.scope_id.clone()).or_default();
        scope.active_team = Some("test-team".to_string());
        scope.teams.insert(
            "test-team".to_string(),
            test_team_session(vec![test_agent("bravo", TeamAgentStatus::Idle)]),
        );
    }
    let (event_tx, _event_rx) = mpsc::unbounded_channel();

    let result = tool.run_stop(json!(""), event_tx).await;

    assert!(!result.is_error);
    let runtime = tool.runtime.read().await;
    let scope = runtime
        .scopes
        .get(&tool.scope_id)
        .expect("scope should remain");
    assert_eq!(scope.active_team, None);
    assert!(!scope.teams.contains_key("test-team"));
}

#[test]
fn task_create_accepts_both_dependency_field_names() {
    let parsed: TaskCreateInput = serde_json::from_value(json!({
        "subject": "wire modules",
        "blockedBy": [1],
        "blocked_by": [2]
    }))
    .expect("task create input should parse");
    let blocked_by = normalize_task_ids(merge_task_id_inputs(
        parsed.blocked_by,
        parsed.blocked_by_snake,
    ))
    .expect("blocked ids should normalize");
    assert_eq!(blocked_by, vec![1, 2]);
}

#[test]
fn task_update_accepts_both_dependency_field_names() {
    let parsed: TaskUpdateInput = serde_json::from_value(json!({
        "taskId": 3,
        "blockedBy": [1],
        "blocked_by": [2],
        "addBlockedBy": [4],
        "add_blocked_by": [5]
    }))
    .expect("task update input should parse");
    let replace = normalize_task_ids(merge_task_id_inputs(
        parsed.blocked_by,
        parsed.blocked_by_snake,
    ))
    .expect("replace ids should normalize");
    let add = normalize_task_ids(merge_task_id_inputs(
        parsed.add_blocked_by,
        parsed.add_blocked_by_snake,
    ))
    .expect("additional ids should normalize");
    assert_eq!(replace, vec![1, 2]);
    assert_eq!(add, vec![4, 5]);
}

#[test]
fn team_run_tasks_accept_initial_dependencies_by_order() {
    let parsed: TeamRunInput = serde_json::from_value(json!({
        "objective": "ship app",
        "agent_names": ["player", "scene"],
        "tasks": [
            { "subject": "scaffold", "owner": "player" },
            { "subject": "polish", "blockedBy": [1] },
            { "subject": "review", "blocked_by": ["#1", "2"] }
        ]
    }))
    .expect("team run input should parse");
    let agent_names =
        prepare_team_agent_names(parsed.agent_names).expect("agent names should normalize");
    let tasks = prepare_team_run_tasks(parsed.tasks.as_deref(), &agent_names)
        .expect("initial tasks should normalize");
    assert_eq!(tasks.len(), 3);
    assert_eq!(tasks[0].owner.as_deref(), Some("player"));
    assert_eq!(tasks[1].blocked_by, vec![1]);
    assert_eq!(tasks[2].blocked_by, vec![1, 2]);
}

#[test]
fn team_run_descriptor_exposes_agent_profiles_as_visible_array() {
    let descriptor = TeamTool::descriptors_static()
        .into_iter()
        .find(|tool| tool.name == TEAM_RUN_TOOL)
        .expect("TeamRun descriptor should exist");

    let schema_type = descriptor
        .input_schema
        .pointer("/properties/agent_profiles/type")
        .and_then(Value::as_str);

    assert_eq!(schema_type, Some("array"));
    assert!(descriptor
        .input_schema
        .pointer("/properties/agent_profiles/items/properties/profile")
        .is_some());
}

#[test]
fn team_run_accepts_agent_profiles_assignments() {
    let parsed: TeamRunInput = serde_json::from_value(json!({
        "objective": "ship app",
        "agent_names": ["player", "scene"],
        "agent_profiles": [
            { "agent": "player", "profile": "gameplay_dev" },
            { "agent": "scene", "profile": "threejs_expert" }
        ]
    }))
    .expect("agent profile assignment list should parse");

    let profiles = parsed
        .agent_profiles
        .expect("profiles should exist")
        .to_profile_map()
        .expect("profiles should normalize");

    assert_eq!(
        profiles.get("player").map(String::as_str),
        Some("gameplay_dev")
    );
    assert_eq!(
        profiles.get("scene").map(String::as_str),
        Some("threejs_expert")
    );
}

#[test]
fn team_run_still_accepts_agent_profiles_map() {
    let parsed: TeamRunInput = serde_json::from_value(json!({
        "objective": "ship app",
        "agent_names": ["player", "scene"],
        "agent_profiles": {
            "player": "gameplay_dev",
            "scene": "threejs_expert"
        }
    }))
    .expect("legacy agent profile map should parse");

    let profiles = parsed
        .agent_profiles
        .expect("profiles should exist")
        .to_profile_map()
        .expect("profiles should normalize");

    assert_eq!(
        profiles.get("player").map(String::as_str),
        Some("gameplay_dev")
    );
    assert_eq!(
        profiles.get("scene").map(String::as_str),
        Some("threejs_expert")
    );
}

#[test]
fn final_responses_are_structured_by_agent_name() {
    let mut alpha = test_agent("alpha", TeamAgentStatus::Idle);
    alpha.history.push(ChatMessage {
        role: Role::Assistant,
        parts: vec![Part::Text {
            text: "Alpha final answer\nwith details".to_string(),
            meta: None,
        }],
    });
    alpha.last_summary = Some("Older summary".to_string());
    let mut bravo = test_agent("bravo", TeamAgentStatus::Error);
    bravo.last_summary = Some("error: failed".to_string());
    bravo.last_error = Some("failed".to_string());
    let session = test_team_session(vec![bravo, alpha]);

    let responses = team_agent_final_responses_from_session(&session);

    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0].agent, "alpha");
    assert_eq!(responses[0].status, "finished");
    assert_eq!(
        responses[0].last_response,
        "Alpha final answer\nwith details"
    );
    assert_eq!(responses[1].agent, "bravo");
    assert_eq!(responses[1].status, "error");
    assert_eq!(responses[1].last_response, "error: failed");
    assert_eq!(responses[1].last_error.as_deref(), Some("failed"));
}

#[test]
fn team_run_tasks_reject_unknown_initial_dependencies() {
    let parsed: TeamRunInput = serde_json::from_value(json!({
        "objective": "ship app",
        "tasks": [
            { "subject": "review", "blockedBy": [2] }
        ]
    }))
    .expect("team run input should parse");
    let agent_names = vec!["reviewer".to_string(), "builder".to_string()];
    let err = prepare_team_run_tasks(parsed.tasks.as_deref(), &agent_names)
        .expect_err("unknown dependencies should fail");
    assert!(err.contains("unknown initial blocking task"));
}

#[test]
fn team_run_tasks_reject_unknown_owner() {
    let parsed: TeamRunInput = serde_json::from_value(json!({
        "objective": "ship app",
        "agent_names": ["player", "scene"],
        "tasks": [
            { "subject": "scaffold", "owner": "audio" }
        ]
    }))
    .expect("team run input should parse");
    let agent_names =
        prepare_team_agent_names(parsed.agent_names).expect("agent names should normalize");
    let err = prepare_team_run_tasks(parsed.tasks.as_deref(), &agent_names)
        .expect_err("unknown owners should fail");
    assert!(err.contains("does not match a teammate"));
}

#[test]
fn team_run_requires_explicit_agent_names() {
    let err = prepare_team_agent_names(None).expect_err("missing names should fail");
    assert!(err.contains("agent_names is required"));
}

#[test]
fn team_run_accepts_up_to_eight_explicit_agent_names() {
    let names = prepare_team_agent_names(Some(vec![
        "player".to_string(),
        "scene".to_string(),
        "track".to_string(),
        "ui".to_string(),
        "audio".to_string(),
        "physics".to_string(),
        "qa".to_string(),
        "polish".to_string(),
    ]))
    .expect("eight agents should be accepted");
    assert_eq!(names.len(), 8);
}

#[test]
fn unblocked_owned_task_queues_wake_for_idle_owner() {
    let mut session = test_team_session(vec![
        test_agent("alpha", TeamAgentStatus::Idle),
        test_agent("bravo", TeamAgentStatus::Idle),
    ]);
    session.tasks.push(test_task(
        1,
        TeamTaskStatus::Completed,
        Some("alpha"),
        Vec::new(),
    ));
    session.tasks.push(test_task(
        2,
        TeamTaskStatus::Blocked,
        Some("bravo"),
        vec![1],
    ));

    let done_ids = completed_task_ids(&session);
    let unblocked = refresh_unblocked_tasks(&mut session, &done_ids);

    assert_eq!(unblocked, vec![2]);
    assert_eq!(session.tasks[1].status, TeamTaskStatus::Pending);
    assert!(session.tasks[1].blocked_by.is_empty());
    assert_eq!(session.pending_task_wakes.len(), 1);
    assert_eq!(session.pending_task_wakes[0].task_id, 2);
    assert_eq!(session.pending_task_wakes[0].owner, "bravo");
}

#[test]
fn pending_task_wake_targets_unblocked_owned_task() {
    let mut session = test_team_session(vec![test_agent("bravo", TeamAgentStatus::Idle)]);
    session
        .tasks
        .push(test_task(1, TeamTaskStatus::Pending, None, Vec::new()));
    session.tasks.push(test_task(
        2,
        TeamTaskStatus::Pending,
        Some("bravo"),
        Vec::new(),
    ));
    session.pending_task_wakes.push(TeamTaskWake {
        task_id: 2,
        owner: "bravo".to_string(),
        created_at_ms: 0,
    });
    let done_ids = completed_task_ids(&session);
    prune_stale_task_wakes(&mut session, &done_ids);
    let wake_task_ids = task_wake_ids_for_agent(&session, &agent_key("bravo"));

    assert_eq!(wake_task_ids.into_iter().collect::<Vec<_>>(), vec![2]);
}

#[test]
fn owned_pending_task_is_runnable_without_explicit_wake() {
    let mut session = test_team_session(vec![test_agent("bravo", TeamAgentStatus::Idle)]);
    session.tasks.push(test_task(
        1,
        TeamTaskStatus::Pending,
        Some("bravo"),
        Vec::new(),
    ));
    let done_ids = completed_task_ids(&session);

    assert_eq!(
        ready_pending_task_id_for_agent(&session, &agent_key("bravo"), &done_ids),
        Some(1)
    );
    assert!(agent_has_runnable_task(
        &session,
        &agent_key("bravo"),
        &done_ids
    ));
}

#[test]
fn sleep_requires_blocked_task_and_no_runnable_owned_work() {
    let mut session = test_team_session(vec![test_agent("bravo", TeamAgentStatus::Idle)]);
    session.tasks.push(test_task(
        1,
        TeamTaskStatus::Blocked,
        Some("bravo"),
        vec![99],
    ));
    let done_ids = completed_task_ids(&session);
    let owner = agent_key("bravo");

    assert!(agent_has_blocked_task(&session, &owner));
    assert!(!agent_has_runnable_task(&session, &owner, &done_ids));

    session.tasks.push(test_task(
        2,
        TeamTaskStatus::Pending,
        Some("bravo"),
        Vec::new(),
    ));

    assert!(agent_has_blocked_task(&session, &owner));
    assert!(agent_has_runnable_task(&session, &owner, &done_ids));
}

#[test]
fn unlocked_task_wake_message_names_task_and_start_command() {
    let task = test_task(2, TeamTaskStatus::Pending, Some("bravo"), Vec::new());

    let message = team_unlocked_task_message(&task);

    assert!(message.contains("#2"));
    assert!(message.contains("task 2"));
    assert!(message.contains("task_list action=update taskId=2 status=in_progress"));
    assert!(message.contains("do not call task_list action=list"));
}

#[test]
fn dependency_lock_rejects_in_progress_with_unresolved_blocker() {
    let done_ids = BTreeSet::new();
    let err =
        validate_task_dependency_lock(2, &[1], &[1], Some(TeamTaskStatus::InProgress), &done_ids)
            .expect_err("unresolved dependency should block in_progress");

    assert!(err.contains("blocked by #1"));
    assert!(err.contains("status=in_progress"));
}

#[test]
fn dependency_lock_rejects_clearing_unresolved_blocker() {
    let done_ids = BTreeSet::new();
    let err = validate_task_dependency_lock(2, &[1], &[], None, &done_ids)
        .expect_err("unresolved dependency should not be manually cleared");

    assert!(err.contains("still blocked by #1"));
    assert!(err.contains("clearing blockedBy"));
}

#[test]
fn dependency_lock_allows_non_status_update_while_blocked() {
    let done_ids = BTreeSet::new();
    validate_task_dependency_lock(2, &[1], &[1], None, &done_ids)
        .expect("blocked task metadata should remain editable");
}

#[test]
fn refresh_reblocks_in_progress_task_with_unresolved_dependency() {
    let mut session = test_team_session(vec![test_agent("bravo", TeamAgentStatus::Idle)]);
    session.tasks.push(test_task(
        1,
        TeamTaskStatus::Pending,
        Some("alpha"),
        Vec::new(),
    ));
    session.tasks.push(test_task(
        2,
        TeamTaskStatus::InProgress,
        Some("bravo"),
        vec![1],
    ));

    let done_ids = completed_task_ids(&session);
    refresh_unblocked_tasks(&mut session, &done_ids);

    assert_eq!(session.tasks[1].status, TeamTaskStatus::Blocked);
    assert_eq!(session.tasks[1].blocked_by, vec![1]);
}

#[test]
fn refresh_clears_satisfied_dependencies_without_forcing_status() {
    let mut session = test_team_session(vec![test_agent("bravo", TeamAgentStatus::Idle)]);
    session.tasks.push(test_task(
        1,
        TeamTaskStatus::Completed,
        Some("alpha"),
        Vec::new(),
    ));
    session.tasks.push(test_task(
        2,
        TeamTaskStatus::InProgress,
        Some("bravo"),
        vec![1],
    ));

    let done_ids = completed_task_ids(&session);
    refresh_unblocked_tasks(&mut session, &done_ids);

    assert_eq!(session.tasks[1].status, TeamTaskStatus::InProgress);
    assert!(session.tasks[1].blocked_by.is_empty());
}

#[test]
fn broadcast_messages_do_not_wake_idle_agents() {
    let broadcast = TeamQueuedMessage {
        id: 1,
        from: "player".to_string(),
        to: "ui".to_string(),
        target: Some("*".to_string()),
        message: "FYI".to_string(),
        created_at_ms: 0,
    };
    assert!(!queued_message_wakes_agent(&broadcast));
}

#[test]
fn direct_messages_wake_idle_agents() {
    let direct = TeamQueuedMessage {
        id: 1,
        from: "player".to_string(),
        to: "ui".to_string(),
        target: Some("ui".to_string()),
        message: "Need you".to_string(),
        created_at_ms: 0,
    };
    assert!(queued_message_wakes_agent(&direct));
}

fn test_team_session(agents: Vec<TeamAgent>) -> TeamSession {
    TeamSession {
        name: "test-team".to_string(),
        description: None,
        created_at_ms: 0,
        updated_at_ms: 0,
        agents: agents
            .into_iter()
            .map(|agent| (agent_key(&agent.name), agent))
            .collect(),
        tasks: Vec::new(),
        next_task_id: 1,
        queued_messages: Vec::new(),
        next_message_id: 1,
        pending_task_wakes: Vec::new(),
        recent_file_changes: Vec::new(),
    }
}

fn test_team_tool() -> TeamTool {
    TeamTool::new(
        "test-scope".to_string(),
        PathBuf::from("."),
        String::new(),
        HashMap::new(),
        SubAgentSettings::default(),
        McpSettings::default(),
        ToolSettings::default(),
        SkillSettings::default(),
        crate::DatabaseTool::new(crate::store::AppStore::in_memory().expect("in-memory store")),
        ModelRef::new("test", "model"),
        1,
        None,
        Arc::new(RwLock::new(TeamRuntime::default())),
        TurnCancel::empty(),
    )
}

fn test_agent(name: &str, status: TeamAgentStatus) -> TeamAgent {
    TeamAgent {
        id: format!("{}@test-team", agent_key(name)),
        name: name.to_string(),
        description: String::new(),
        prompt: String::new(),
        model: ModelRef::new("test", "model"),
        status,
        history: Vec::new(),
        created_at_ms: 0,
        updated_at_ms: 0,
        last_summary: None,
        last_error: None,
    }
}

fn test_task(
    id: u64,
    status: TeamTaskStatus,
    owner: Option<&str>,
    blocked_by: Vec<u64>,
) -> TeamTask {
    TeamTask {
        id,
        subject: format!("task {id}"),
        description: None,
        status,
        owner: owner.map(str::to_string),
        blocked_by,
        created_by: "test".to_string(),
        created_at_ms: 0,
        updated_at_ms: 0,
        completed_at_ms: (status == TeamTaskStatus::Completed).then_some(0),
    }
}

/// Provider synthétique : n'accepte que les modèles listés, sans appel réseau.
struct SwarmTestProvider {
    name: &'static str,
    models: Vec<&'static str>,
    supports_thinking: bool,
}

#[async_trait::async_trait]
impl Provider for SwarmTestProvider {
    fn name(&self) -> &str {
        self.name
    }

    fn capabilities(&self, model: &ModelRef) -> Option<claakecode_core::ModelCapabilities> {
        if !self.models.iter().any(|name| *name == model.name) {
            return None;
        }
        Some(claakecode_core::ModelCapabilities {
            model: model.clone(),
            context_window: 1000,
            preferred_window: 1000,
            max_output_tokens: 100,
            supports_thinking: self.supports_thinking,
            visible_thinking: false,
            supports_tools: true,
            supports_images: false,
            effort_mode: if self.supports_thinking {
                claakecode_core::EffortMode::Tier
            } else {
                claakecode_core::EffortMode::None
            },
        })
    }

    async fn estimate_tokens(
        &self,
        _request: claakecode_core::ProviderRequest,
    ) -> claakecode_core::Result<claakecode_core::TokenEstimate> {
        unreachable!("swarm config tests never call the provider")
    }

    async fn stream(
        &self,
        _request: claakecode_core::ProviderRequest,
    ) -> claakecode_core::Result<claakecode_core::ProviderStream> {
        unreachable!("swarm config tests never call the provider")
    }
}

fn swarm_test_tool(
    lead: ModelRef,
    settings: SubAgentSettings,
    providers: Vec<(&'static str, Arc<dyn Provider>)>,
) -> TeamTool {
    let providers = providers
        .into_iter()
        .map(|(name, provider)| (name.to_string(), provider))
        .collect();
    TeamTool::new(
        "test-scope".to_string(),
        PathBuf::from("."),
        String::new(),
        providers,
        settings,
        McpSettings::default(),
        ToolSettings::default(),
        SkillSettings::default(),
        crate::DatabaseTool::new(crate::store::AppStore::in_memory().expect("in-memory store")),
        lead,
        1,
        None,
        Arc::new(RwLock::new(TeamRuntime::default())),
        TurnCancel::empty(),
    )
}

fn swarm_test_providers() -> Vec<(&'static str, Arc<dyn Provider>)> {
    vec![
        (
            "anthropic",
            Arc::new(SwarmTestProvider {
                name: "anthropic",
                models: vec!["claude-haiku-5-5", "claude-sonnet-5", "claude-opus-5"],
                supports_thinking: true,
            }) as Arc<dyn Provider>,
        ),
        (
            "openai",
            Arc::new(SwarmTestProvider {
                name: "openai",
                models: vec!["gpt-6-luna"],
                supports_thinking: false,
            }) as Arc<dyn Provider>,
        ),
    ]
}

fn swarm_names(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

fn swarm_model_input(agent: &str, model: &str, thinking: Option<&str>) -> model::AgentModelAssignmentInput {
    model::AgentModelAssignmentInput {
        agent: agent.to_string(),
        model: model.to_string(),
        thinking: thinking.map(str::to_string),
    }
}

#[test]
fn agent_models_parse_provider_model_and_thinking() {
    let parsed: TeamRunInput = serde_json::from_value(json!({
        "objective": "ship app",
        "agent_names": ["ui", "api"],
        "agent_models": [
            { "agent": "ui", "model": "anthropic:claude-sonnet-5", "thinking": "high" },
            { "agent": "api", "model": "openai:gpt-6-luna" }
        ]
    }))
    .expect("agent_models should parse");
    let models = parsed.agent_models.expect("agent_models should exist");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].thinking.as_deref(), Some("high"));
    assert!(models[1].thinking.is_none());
}

#[test]
fn agent_models_descriptor_exposes_provider_name_format() {
    let descriptor = TeamTool::descriptors_static()
        .into_iter()
        .find(|tool| tool.name == TEAM_RUN_TOOL)
        .expect("TeamRun descriptor should exist");
    assert_eq!(
        descriptor
            .input_schema
            .pointer("/properties/agent_models/type")
            .and_then(Value::as_str),
        Some("array")
    );
    assert!(descriptor
        .input_schema
        .pointer("/properties/agent_models/items/properties/model")
        .is_some());
}

#[test]
fn agent_model_priority_is_models_then_profile_then_settings_then_lead() {
    let profile = SubAgentConfig {
        id: "reviewer".to_string(),
        name: "reviewer".to_string(),
        description: "Reviews code".to_string(),
        prompt: "Be strict.".to_string(),
        model: ModelRef::new("anthropic", "claude-opus-5"),
        hide_for_same_model: false,
        enabled: true,
        swarm_enabled: true,
    };
    let settings = SubAgentSettings {
        agents: vec![profile],
        swarm: SwarmSettings {
            teammate_model_source: SwarmTeammateModelSource::Explicit,
            teammate_model: Some(ModelRef::new("anthropic", "claude-sonnet-5")),
            ..SwarmSettings::default()
        },
    };
    let tool = swarm_test_tool(
        ModelRef::new("anthropic", "claude-opus-5"),
        settings,
        swarm_test_providers(),
    );
    let names = swarm_names(&["ui", "api", "review"]);
    let mut profiles = HashMap::new();
    profiles.insert("review".to_string(), "reviewer".to_string());
    let models = vec![swarm_model_input("ui", "openai:gpt-6-luna", Some("off"))];

    let configs = tool
        .prepare_team_agent_configs(&names, Some(&profiles), Some(&models))
        .expect("configs should prepare");

    // agent_models gagne sur le défaut Settings.
    assert_eq!(configs[0].model.provider, "openai");
    assert_eq!(configs[0].model.name, "gpt-6-luna");
    assert_eq!(configs[0].model.effort, Some(claakecode_core::Effort::None));
    // Sans agent_models : le profil garde son modèle, prompt et description.
    assert_eq!(configs[2].model.name, "claude-opus-5");
    assert_eq!(configs[2].description, "Reviews code");
    assert_eq!(configs[2].prompt, "Be strict.");
    // Sans rien : défaut Settings explicite.
    assert_eq!(configs[1].model.name, "claude-sonnet-5");
}

#[test]
fn agent_model_profile_keeps_prompt_when_models_override_it() {
    let profile = SubAgentConfig {
        id: "reviewer".to_string(),
        name: "reviewer".to_string(),
        description: "Reviews code".to_string(),
        prompt: "Be strict.".to_string(),
        model: ModelRef::new("anthropic", "claude-opus-5"),
        hide_for_same_model: false,
        enabled: true,
        swarm_enabled: true,
    };
    let tool = swarm_test_tool(
        ModelRef::new("anthropic", "claude-opus-5"),
        SubAgentSettings {
            agents: vec![profile],
            ..SubAgentSettings::default()
        },
        swarm_test_providers(),
    );
    let names = swarm_names(&["review", "api"]);
    let mut profiles = HashMap::new();
    profiles.insert("review".to_string(), "reviewer".to_string());
    let models = vec![swarm_model_input("review", "anthropic:claude-sonnet-5", None)];

    let configs = tool
        .prepare_team_agent_configs(&names, Some(&profiles), Some(&models))
        .expect("configs should prepare");
    assert_eq!(configs[0].model.name, "claude-sonnet-5");
    assert_eq!(configs[0].prompt, "Be strict.");
    assert_eq!(configs[0].description, "Reviews code");
}

#[test]
fn agent_models_reject_invalid_format_unknown_agent_and_unknown_model() {
    let tool = swarm_test_tool(
        ModelRef::new("anthropic", "claude-opus-5"),
        SubAgentSettings::default(),
        swarm_test_providers(),
    );
    let names = swarm_names(&["ui", "api"]);

    let no_colon = vec![swarm_model_input("ui", "gpt-6-luna", None)];
    let err = tool
        .prepare_team_agent_configs(&names, None, Some(&no_colon))
        .expect_err("model without provider must fail");
    assert!(err.contains("provider:name"));

    let unknown_agent = vec![swarm_model_input("ghost", "anthropic:claude-sonnet-5", None)];
    let err = tool
        .prepare_team_agent_configs(&names, None, Some(&unknown_agent))
        .expect_err("unknown teammate must fail");
    assert!(err.contains("unknown teammate `ghost`"));

    // Modèle inconnu du provider : erreur explicite, pas de repli silencieux.
    let unknown_model = vec![swarm_model_input("ui", "anthropic:claude-unknown", None)];
    let err = tool
        .prepare_team_agent_configs(&names, None, Some(&unknown_model))
        .expect_err("unknown model must fail");
    assert!(err.contains("not supported"));
}

#[test]
fn agent_models_reject_provider_not_configured() {
    let tool = swarm_test_tool(
        ModelRef::new("anthropic", "claude-opus-5"),
        SubAgentSettings::default(),
        swarm_test_providers(),
    );
    let names = swarm_names(&["ui", "api"]);
    let models = vec![swarm_model_input("ui", "mistral:mistral-large", None)];
    let err = tool
        .prepare_team_agent_configs(&names, None, Some(&models))
        .expect_err("unconfigured provider must fail");
    assert!(err.contains("not configured or missing credentials"));
}

#[test]
fn agent_models_reject_unsupported_effort() {
    let tool = swarm_test_tool(
        ModelRef::new("anthropic", "claude-opus-5"),
        SubAgentSettings::default(),
        swarm_test_providers(),
    );
    let names = swarm_names(&["ui", "api"]);
    // gpt-6-luna sans thinking : effort `high` refusé.
    let models = vec![swarm_model_input("ui", "openai:gpt-6-luna", Some("high"))];
    let err = tool
        .prepare_team_agent_configs(&names, None, Some(&models))
        .expect_err("unsupported effort must fail");
    assert!(err.contains("does not support thinking effort"));

    let bad_thinking = vec![swarm_model_input("ui", "anthropic:claude-sonnet-5", Some("ultra"))];
    let err = tool
        .prepare_team_agent_configs(&names, None, Some(&bad_thinking))
        .expect_err("unknown thinking must fail");
    assert!(err.contains("unknown agent_models thinking"));
}

#[test]
fn swarm_teammate_default_follows_settings_source() {
    let lead = ModelRef::new("anthropic", "claude-opus-5");
    let names = swarm_names(&["ui", "api"]);

    let auto = swarm_test_tool(lead.clone(), SubAgentSettings::default(), swarm_test_providers());
    let configs = auto
        .prepare_team_agent_configs(&names, None, None)
        .expect("auto configs");
    assert_eq!(configs[0].model.name, DEFAULT_ANTHROPIC_TEAMMATE_MODEL);

    let lead_settings = SubAgentSettings {
        swarm: SwarmSettings {
            teammate_model_source: SwarmTeammateModelSource::Lead,
            ..SwarmSettings::default()
        },
        ..SubAgentSettings::default()
    };
    let inherit = swarm_test_tool(lead.clone(), lead_settings, swarm_test_providers());
    let configs = inherit
        .prepare_team_agent_configs(&names, None, None)
        .expect("lead configs");
    assert_eq!(configs[0].model, lead);
}

#[test]
fn swarm_max_teammates_setting_is_enforced() {
    let settings = SubAgentSettings {
        swarm: SwarmSettings {
            max_teammates: Some(2),
            ..SwarmSettings::default()
        },
        ..SubAgentSettings::default()
    };
    let tool = swarm_test_tool(
        ModelRef::new("anthropic", "claude-opus-5"),
        settings,
        swarm_test_providers(),
    );
    let names = swarm_names(&["a", "b", "c"]);
    let err = tool
        .prepare_team_agent_configs(&names, None, None)
        .expect_err("third teammate must be refused");
    assert!(err.contains("at most 2 teammates"));
}

#[test]
fn swarm_profile_disabled_for_swarms_is_refused() {
    let profile = SubAgentConfig {
        id: "reviewer".to_string(),
        name: "reviewer".to_string(),
        description: String::new(),
        prompt: String::new(),
        model: ModelRef::new("anthropic", "claude-opus-5"),
        hide_for_same_model: false,
        enabled: true,
        swarm_enabled: false,
    };
    let tool = swarm_test_tool(
        ModelRef::new("anthropic", "claude-opus-5"),
        SubAgentSettings {
            agents: vec![profile],
            ..SubAgentSettings::default()
        },
        swarm_test_providers(),
    );
    let names = swarm_names(&["review", "api"]);
    let mut profiles = HashMap::new();
    profiles.insert("review".to_string(), "reviewer".to_string());
    let err = tool
        .prepare_team_agent_configs(&names, Some(&profiles), None)
        .expect_err("profile not enabled for swarms must fail");
    assert!(err.contains("not enabled for agent swarms"));
}

#[test]
fn sub_agent_settings_without_swarm_block_still_load() {
    let loaded: SubAgentSettings = serde_json::from_value(json!({
        "agents": [{
            "id": "reviewer",
            "name": "reviewer",
            "description": "",
            "prompt": "",
            "model": { "provider": "anthropic", "name": "claude-opus-5" }
        }]
    }))
    .expect("legacy settings should load");
    let normalized = loaded.normalized();
    assert_eq!(normalized.swarm, SwarmSettings::default());
    assert!(normalized.agents[0].swarm_enabled);

    let round_trip: SubAgentSettings = serde_json::from_str(
        &serde_json::to_string(&normalized).expect("serialize"),
    )
    .expect("round trip");
    assert_eq!(round_trip.swarm, SwarmSettings::default());
}

#[test]
fn swarm_settings_round_trip_and_clamp() {
    let settings: SubAgentSettings = serde_json::from_value::<SubAgentSettings>(json!({
        "agents": [],
        "swarm": {
            "teammateModelSource": "explicit",
            "teammateModel": { "provider": "openai", "name": "gpt-6-luna" },
            "maxTeammates": 20,
            "maxTurnsPerAgent": 0,
            "maxSwarmDurationSecs": 900
        }
    }))
    .expect("swarm settings should load")
    .normalized();
    assert_eq!(
        settings.swarm.teammate_model_source,
        SwarmTeammateModelSource::Explicit
    );
    assert_eq!(settings.swarm.max_teammates, Some(SWARM_MAX_TEAMMATES));
    assert_eq!(settings.swarm.max_turns_per_agent, None);
    assert_eq!(settings.swarm.max_swarm_duration_secs, Some(900));

    let json = serde_json::to_value(&settings).expect("serialize");
    assert_eq!(json["swarm"]["maxSwarmDurationSecs"], json!(900));
    assert_eq!(json["swarm"]["teammateModelSource"], json!("explicit"));
}

#[test]
fn explicit_swarm_model_without_model_falls_back_to_auto() {
    let settings = SubAgentSettings {
        swarm: SwarmSettings {
            teammate_model_source: SwarmTeammateModelSource::Explicit,
            teammate_model: None,
            ..SwarmSettings::default()
        },
        ..SubAgentSettings::default()
    }
    .normalized();
    assert_eq!(settings.swarm.teammate_model_source, SwarmTeammateModelSource::Auto);
}
