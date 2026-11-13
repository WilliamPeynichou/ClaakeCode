//! Test-only scripted provider and turn context (lot C4): runs the real agent loop without a model.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::mpsc;

use claakecode_core::{
    AppError, ModelCapabilities, ModelRef, PartKind, Provider, ProviderRequest, ProviderStream,
    StopReason, StreamEvent, TokenEstimate, ToolCallIntro, Usage,
};

use super::{AgentEvent, AgentMode, TurnCancel, TurnContext};
use crate::{
    AppStore, BashTool, CreateImageTool, DatabaseTool, EditFileTool, GlobTool, GrepTool,
    McpToolRegistry, PythonTool, ReadTool, SkillTool, ToDoListTool, WebFetchTool, WebSearchTool,
    WriteFileTool,
};

/// Replays one scripted response per `stream` call; an exhausted script answers with empty text.
pub(crate) struct ScriptedProvider {
    responses: Mutex<Vec<Vec<StreamEvent>>>,
    pub(crate) calls: AtomicUsize,
}

impl ScriptedProvider {
    pub(crate) fn new(mut responses: Vec<Vec<StreamEvent>>) -> Arc<Self> {
        responses.reverse();
        Arc::new(Self { responses: Mutex::new(responses), calls: AtomicUsize::new(0) })
    }

    pub(crate) fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl Provider for ScriptedProvider {
    fn name(&self) -> &str {
        "scripted"
    }

    /// `None` disables automatic compaction.
    fn capabilities(&self, _model: &ModelRef) -> Option<ModelCapabilities> {
        None
    }

    async fn estimate_tokens(&self, _request: ProviderRequest) -> Result<TokenEstimate, AppError> {
        Ok(TokenEstimate { input_tokens: 0, exact: false })
    }

    async fn stream(&self, _request: ProviderRequest) -> Result<ProviderStream, AppError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let events = self.responses.lock().unwrap().pop().unwrap_or_else(|| text_response(""));
        Ok(futures_util::stream::iter(events.into_iter().map(Ok)).boxed())
    }
}

pub(crate) fn text_response(text: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart { model: "scripted".into() },
        StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
        StreamEvent::TextDelta { index: 0, delta: text.to_string() },
        StreamEvent::PartStop { index: 0 },
        StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage: Usage::default() },
    ]
}

pub(crate) fn tool_response(id: &str, name: &str, input: Value) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart { model: "scripted".into() },
        StreamEvent::PartStart {
            index: 0,
            kind: PartKind::ToolCall,
            tool: Some(ToolCallIntro { id: id.to_string(), name: name.to_string() }),
        },
        StreamEvent::ToolJsonDelta { index: 0, chunk: input.to_string() },
        StreamEvent::PartStop { index: 0 },
        StreamEvent::MessageStop { stop_reason: StopReason::ToolUse, usage: Usage::default() },
    ]
}

/// Real tools on `workspace_root`, an in-memory store, no question tool, no sub-agents, no team.
pub(crate) fn test_turn_context(
    provider: Arc<ScriptedProvider>,
    workspace_root: &Path,
) -> (TurnContext, mpsc::UnboundedReceiver<AgentEvent>, AppStore) {
    let root = workspace_root.to_path_buf();
    let store = AppStore::in_memory().expect("in-memory store");
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    // A closed command channel makes the loop spin on `recv() == None`: keep the sender alive.
    std::mem::forget(cmd_tx);
    let context = TurnContext {
        provider,
        model: ModelRef::new("scripted", "scripted"),
        cache_key: None,
        cache_stable_message_count: 0,
        service_tier: None,
        auto_compact: false,
        mode: AgentMode::Act,
        stop_questions: false,
        system_prompt: String::new(),
        history: vec![claakecode_core::ChatMessage::user_text("go".to_string())],
        todo_list: Default::default(),
        goal_workflow: Default::default(),
        bash: Arc::new(BashTool::new(root.clone())),
        python: Arc::new(PythonTool::new(root.clone())),
        glob: Arc::new(GlobTool::new(root.clone())),
        grep: Arc::new(GrepTool::new(root.clone())),
        read: Arc::new(ReadTool::new(root.clone())),
        edit_file: Arc::new(EditFileTool::new(root.clone())),
        write_file: Arc::new(WriteFileTool::new(root.clone())),
        create_image: Arc::new(CreateImageTool::new(root.clone())),
        todo_list_tool: Some(Arc::new(ToDoListTool::new())),
        question: None,
        web_search: Arc::new(WebSearchTool::new()),
        web_fetch: Arc::new(WebFetchTool::new()),
        skill: Arc::new(SkillTool::new(root.clone())),
        database: Arc::new(DatabaseTool::new(store.clone())),
        mcp: Arc::new(McpToolRegistry::new(Default::default())),
        subagents: None,
        teams: None,
        tool_settings: Default::default(),
        event_scope: None,
        max_tool_rounds: 20,
        event_tx,
        cancel: TurnCancel::empty(),
        cmd_rx,
        run: None,
    };
    (context, event_rx, store)
}
