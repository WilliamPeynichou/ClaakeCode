//! Boundary for Prime Agent daemon v7 (pin f24bcccebcfc).
//! No Prime crates are linked; wire identifiers deliberately retain upstream names.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const PROTOCOL_VERSION: u32 = 7;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

const SESSION_ALREADY_OPEN: &str =
    "session already open in another Prime process (quit Claake Code completely, including Claaky in the menu bar and the dev version, then reopen it)";

/// Only fixed categories cross the boundary; even short upstream strings can contain secrets.
fn error_category(raw: &str) -> &'static str {
    if raw.starts_with("Model not found:") { "model unavailable" }
    else if raw.starts_with("No API key found for ") { "provider authentication unavailable" }
    else if raw.starts_with("Unknown active session:") || raw.starts_with("Session not found:") { "session unavailable" }
    else if raw == "Session worker timed out" { "session worker timed out" }
    else if matches!(raw, "Supervisor is shutting down" | "supervisor is shutting down" | "Session is shutting down") { "daemon shutting down" }
    else if raw == "Worker authentication failed" { "worker authentication refused" }
    else if raw.starts_with("Invalid create config:") || raw.starts_with("Invalid thinking level") { "invalid session configuration" }
    else if raw.starts_with("Agent name \"") && raw.ends_with("\" is unavailable: an agent of that name already exists at depth 0 under this parent") { "another Prime session already uses this name" }
    else if raw.starts_with("continueRecent is not supported:") { "explicit sessionPath required" }
    else if raw.contains("is already active in") || raw.starts_with("This session is currently open in another") { SESSION_ALREADY_OPEN }
    else { "unclassified failure (upstream details withheld)" }
}

fn rejection(kind: &str, frame: &Value) -> String {
    // Command names are caller-controlled too: display only known wire tags.
    let kind = match kind {
        "create" | "attach" | "abort" | "set_model" | "set_thinking_level" | "prompt" |
        "prompt_and_wait" | "list" | "shutdown" | "get_messages" | "get_available_models" |
        "wait_for_headless_completion" | "abort_and_clear_queue" => kind,
        _ => "unknown",
    };
    if frame["errorInfo"]["code"].as_str() == Some("session_already_active") {
        return format!("Prime daemon rejected command `{kind}`: {SESSION_ALREADY_OPEN}");
    }
    let raw = frame["error"].as_str().or_else(|| frame["error"]["message"].as_str()).unwrap_or("");
    format!("Prime daemon rejected command `{kind}`: {}", error_category(raw))
}

pub fn command_frame(id: &str, command: Value) -> Result<Value> {
    if command.get("type").and_then(Value::as_str).is_none() {
        bail!("Prime command requires a type");
    }
    Ok(json!({"type":"command", "id":id,
        "protocol":{"name":"prime-agent.daemon","version":PROTOCOL_VERSION},
        "command":command}))
}

#[cfg(unix)]
type Stream = tokio::net::UnixStream;
#[cfg(windows)]
type Stream = tokio::net::windows::named_pipe::NamedPipeClient;

/// Opens the daemon endpoint: a socket file on Unix, a named pipe (`\\.\pipe\...`) on Windows.
#[cfg(unix)]
async fn open_stream(endpoint: &std::path::Path) -> std::io::Result<Stream> {
    tokio::net::UnixStream::connect(endpoint).await
}

#[cfg(windows)]
async fn open_stream(endpoint: &std::path::Path) -> std::io::Result<Stream> {
    // Every pipe instance may be serving another client for a moment: wait for a free one.
    const ERROR_PIPE_BUSY: i32 = 231;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint) {
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            result => return result,
        }
    }
}

pub struct Connection {
    reader: BufReader<tokio::io::ReadHalf<Stream>>,
    writer: tokio::io::WriteHalf<Stream>,
}

impl Connection {
    pub async fn connect(socket: &std::path::Path) -> Result<Self> {
        let stream = open_stream(socket).await.context("connect Prime daemon")?;
        let (reader, writer) = tokio::io::split(stream);
        Ok(Self { reader: BufReader::new(reader), writer })
    }

    /// Returns the correlation ID; callers retain ownership of the connection.
    pub async fn send(&mut self, command: Value) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut bytes = serde_json::to_vec(&command_frame(&id, command)?)?;
        if bytes.len() >= MAX_FRAME_BYTES { bail!("Prime command exceeds frame limit"); }
        bytes.push(b'\n');
        self.writer.write_all(&bytes).await?;
        Ok(id)
    }

    /// A cancelled read must discard this connection: a partial frame may be consumed.
    /// No implicit reconnection or replay of mutations is performed here.
    pub async fn receive(&mut self) -> Result<Value> {
        loop {
            let mut frame = Vec::new();
            loop {
                let chunk = self.reader.fill_buf().await?;
                if chunk.is_empty() { bail!("Prime daemon disconnected before response"); }
                let n = chunk.iter().position(|b| *b == b'\n').map(|n| n + 1).unwrap_or(chunk.len());
                if frame.len() + n > MAX_FRAME_BYTES { bail!("Prime daemon frame exceeds limit"); }
                let complete = chunk[n - 1] == b'\n';
                frame.extend_from_slice(&chunk[..n]);
                self.reader.consume(n);
                if complete { break; }
            }
            if frame.iter().all(u8::is_ascii_whitespace) { continue; }
            return serde_json::from_slice(&frame).context("invalid Prime daemon JSON");
        }
    }
}

/// A dedicated connection per command keeps abort independent of a running prompt.
/// Notifications received while awaiting a response are delivered to the caller.
/// Timeout/cancellation closes the connection: uncertain mutations must NOT be retried.
pub async fn call(
    socket: &std::path::Path,
    command: Value,
    timeout: Duration,
    mut on_event: impl FnMut(Value),
) -> Result<Value> {
    tokio::time::timeout(timeout, async {
        let mut connection = Connection::connect(socket).await?;
        let kind = command["type"].as_str().unwrap_or("?").to_string();
        let id = connection.send(command).await?;
        loop {
            let value = connection.receive().await?;
            if value["type"] == "response" && value["id"] == id {
                if value["success"] != true {
                    bail!("{}", rejection(&kind, &value));
                }
                return Ok(value.get("data").cloned().unwrap_or(Value::Null));
            }
            on_event(value);
        }
    }).await.context("Prime command timed out; outcome may be unknown, do not retry automatically")?
}

/// Host-neutral view of a Prime `session_event`. The UI never sees raw Prime JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum PrimeEvent {
    TurnStarted,
    /// Cumulative assistant text (Prime sends the whole content on each update).
    AssistantText { text: String },
    ToolStarted { id: String, name: String },
    ToolFinished { id: String, name: String, is_error: bool },
    /// Terminal for the run; `error` carries a bounded message when the turn failed.
    TurnEnded { error: Option<String> },
    /// Valid but unmapped: kept out of the transcript, never shown as success.
    Other(String),
}

/// Ordering metadata; callers drop `sequence <= last_seen` after a resync.
#[derive(Debug, Clone, PartialEq)]
pub struct PrimeEnvelope {
    pub session_id: String,
    pub sequence: Option<u64>,
    pub replayed: bool,
    pub event: PrimeEvent,
}

fn assistant_text(message: &Value) -> Option<String> {
    if message["role"] != "assistant" { return None; }
    let text: String = message["content"].as_array()?.iter()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect();
    Some(text)
}

/// Returns `None` for frames that are not session events (responses, roster, hello...).
pub fn map_session_event(frame: &Value) -> Option<PrimeEnvelope> {
    if frame["type"] != "session_event" { return None; }
    let event = &frame["event"];
    let kind = event["type"].as_str()?;
    let str_of = |key: &str| event[key].as_str().unwrap_or_default().to_string();
    let mapped = match kind {
        "agent_start" => PrimeEvent::TurnStarted,
        "message_update" | "message_end" => match assistant_text(&event["message"]) {
            Some(text) => PrimeEvent::AssistantText { text },
            None => PrimeEvent::Other(kind.into()),
        },
        "tool_execution_start" => PrimeEvent::ToolStarted { id: str_of("toolCallId"), name: str_of("toolName") },
        "tool_execution_end" => PrimeEvent::ToolFinished {
            id: str_of("toolCallId"), name: str_of("toolName"),
            is_error: event["isError"].as_bool().unwrap_or(false),
        },
        "agent_end" => {
            // A failed run ends with an assistant message whose stopReason is error/aborted.
            let last = event["messages"].as_array().and_then(|m| m.iter().rev().find(|m| m["role"] == "assistant"));
            let error = last.and_then(stop_error);
            PrimeEvent::TurnEnded { error }
        }
        other => PrimeEvent::Other(other.into()),
    };
    Some(PrimeEnvelope {
        session_id: frame["activeSessionId"].as_str().unwrap_or_default().to_string(),
        sequence: frame["meta"]["sequence"].as_u64(),
        replayed: frame["meta"]["replayed"].as_bool().unwrap_or(false),
        event: mapped,
    })
}

/// Converts Prime events to the existing `AgentEvent` stream so the current chat UI renders RLM turns.
/// Prime sends cumulative text; this emits only the new suffix. Sequences already seen are dropped
/// (replay after reattach), so a resync never duplicates text.
#[derive(Default)]
pub struct RlmStream {
    last_sequence: Option<u64>,
    text: String,
    text_open: bool,
    /// Tools started but not yet finished; closed on a terminal resync so the UI never spins.
    open_tools: Vec<String>,
}

impl RlmStream {
    pub fn last_sequence(&self) -> Option<u64> { self.last_sequence }

    /// A stream for a new turn on a session whose history ends at `sequence`.
    pub fn starting_after(sequence: u64) -> Self {
        Self { last_sequence: Some(sequence), ..Self::default() }
    }

    /// Reconciles after a reattach. With a complete replay nothing was missed. Otherwise the
    /// snapshot fills the gap: missing text suffix, open tools closed, and the turn end when
    /// Prime is no longer streaming. Returns the events and whether the turn is over.
    pub fn resync(&mut self, snapshot: &AttachSnapshot) -> (Vec<crate::AgentEvent>, bool) {
        use crate::AgentEvent as E;
        let mut out = Vec::new();
        if snapshot.replay_complete && snapshot.streaming {
            return (out, false);
        }
        // Events up to the snapshot are accounted for by the snapshot itself.
        self.last_sequence = Some(self.last_sequence.unwrap_or(0).max(snapshot.last_sequence));
        if snapshot.streaming {
            // Mid-run: the next cumulative message_update carries the full text; suffix logic
            // then emits only what is new.
            return (out, false);
        }
        for id in std::mem::take(&mut self.open_tools) {
            out.push(E::ToolFinished { id, output: String::new(), is_error: false,
                file_changes: Vec::new(), images: Vec::new(), meta: None });
        }
        let final_text = snapshot.last_assistant.as_ref().and_then(assistant_text).unwrap_or_default();
        // Only append a strict continuation of what was shown; never re-emit or rewrite.
        if let Some(rest) = final_text.strip_prefix(self.text.as_str()) {
            if !rest.is_empty() {
                if !self.text_open { self.text_open = true; out.push(E::TextStarted); }
                out.push(E::TextChunk { delta: rest.to_string() });
                self.text = final_text.clone();
            }
        }
        if self.text_open { self.text_open = false; out.push(E::TextFinished); }
        match snapshot.last_assistant.as_ref().and_then(stop_error) {
            Some(m) if m == "aborted" => out.push(E::Interrupted),
            Some(message) => out.push(E::Error { message }),
            None => out.push(E::TurnFinished { duration_ms: None }),
        }
        (out, true)
    }

    pub fn push(&mut self, envelope: PrimeEnvelope) -> Vec<crate::AgentEvent> {
        use crate::AgentEvent as E;
        if let Some(seq) = envelope.sequence {
            if self.last_sequence.is_some_and(|last| seq <= last) { return Vec::new(); }
            self.last_sequence = Some(seq);
        }
        let mut out = Vec::new();
        match envelope.event {
            PrimeEvent::TurnStarted => { self.text.clear(); self.text_open = false; out.push(E::TurnStarted); }
            PrimeEvent::AssistantText { text } => {
                if !self.text_open { self.text_open = true; out.push(E::TextStarted); }
                // A shorter or divergent text means a new assistant message: restart from scratch.
                let delta = match text.strip_prefix(self.text.as_str()) {
                    Some(rest) => rest.to_string(),
                    None => { out.push(E::TextFinished); out.push(E::TextStarted); text.clone() }
                };
                if !delta.is_empty() { out.push(E::TextChunk { delta }); }
                self.text = text;
            }
            PrimeEvent::ToolStarted { id, name } => {
                if self.text_open { self.text_open = false; out.push(E::TextFinished); }
                self.text.clear();
                self.open_tools.push(id.clone());
                out.push(E::ToolStarted { id, name });
            }
            PrimeEvent::ToolFinished { id, is_error, .. } => {
                self.open_tools.retain(|open| open != &id);
                out.push(E::ToolFinished {
                    id, output: String::new(), is_error, file_changes: Vec::new(), images: Vec::new(), meta: None,
                });
            }
            PrimeEvent::TurnEnded { error } => {
                if self.text_open { self.text_open = false; out.push(E::TextFinished); }
                match error {
                    Some(m) if m == "aborted" => out.push(E::Interrupted),
                    Some(message) => out.push(E::Error { message }),
                    None => out.push(E::TurnFinished { duration_ms: None }),
                }
            }
            PrimeEvent::Other(_) => {}
        }
        out
    }
}

/// Creates a persisted Prime session (persistence is required for RLM children). `cwd` is canonicalised.
pub async fn create_session(socket: &std::path::Path, cwd: &std::path::Path, name: &str, script: Option<&std::path::Path>) -> Result<String> {
    Ok(create_session_with(socket, cwd, name, script, None).await?.0)
}

/// Creates a session, or reopens the persisted one at `session_path` (Prime refuses
/// `continueRecent` by design). Returns the live id and the session file to store for reopening.
pub async fn create_session_with(
    socket: &std::path::Path, cwd: &std::path::Path, name: &str, script: Option<&std::path::Path>,
    session_path: Option<&str>,
) -> Result<(String, Option<String>)> {
    create_session_config(socket, cwd, name, script, session_path, None).await
}

/// Native Prime session: keep the base RLM prompt and append only host policy.
/// `harness` is not a create-config selector in the pinned daemon; do not invent one.
pub async fn create_rlm_session_with(
    socket: &std::path::Path, cwd: &std::path::Path, name: &str,
    session_path: Option<&str>, append_system_prompt: &str,
) -> Result<(String, Option<String>)> {
    let created = create_session_config(socket, cwd, name, None, session_path, Some(append_system_prompt)).await?;
    if created.1.as_deref().is_none_or(|path| path.trim().is_empty()) {
        bail!("Prime did not provide persisted RLM session");
    }
    Ok(created)
}

async fn create_session_config(
    socket: &std::path::Path, cwd: &std::path::Path, name: &str,
    script: Option<&std::path::Path>, session_path: Option<&str>, append_system_prompt: Option<&str>,
) -> Result<(String, Option<String>)> {
    let cwd = plain_path(std::fs::canonicalize(cwd).context("canonicalise session cwd")?);
    let mut config = json!({"cwd": cwd});
    if let Some(policy) = append_system_prompt { config["appendSystemPrompt"] = json!([policy]); }
    if let Some(script) = script { config["script"] = json!(plain_path(std::fs::canonicalize(script)?)); }
    let mut command = json!({"type":"create","name":name,"config":config});
    if let Some(path) = session_path { command["sessionPath"] = json!(path); }
    let data = call(socket, command, Duration::from_secs(60), |_| {}).await?;
    let id = data["activeSessionId"].as_str().map(str::to_string).context("Prime create returned no session id")?;
    Ok((id, data["sessionFile"].as_str().map(str::to_string)))
}

/// Aborts through its own connection so it never waits behind the streaming one.
pub async fn abort_session(socket: &std::path::Path, session_id: &str) -> Result<()> {
    call(socket, json!({"type":"abort","activeSessionId":session_id}), Duration::from_secs(10), |_| {}).await.map(|_| ())
}

/// Selects the session model. Prime refuses unknown or signed-out providers; that refusal is
/// surfaced (never a silent fallback to another model).
pub async fn set_model(socket: &std::path::Path, session_id: &str, provider: &str, model_id: &str) -> Result<()> {
    call(
        socket,
        json!({"type":"set_model","activeSessionId":session_id,"provider":provider,"modelId":model_id}),
        Duration::from_secs(30),
        |_| {},
    )
    .await
    .map(|_| ())
}

/// True when Prime refused a model because it is not in its catalog (as opposed to a missing
/// sign-in or a dead session). Only this refusal is fixed by declaring the model.
pub fn is_model_unavailable(error: &anyhow::Error) -> bool {
    error.to_string().ends_with(": model unavailable")
}

/// Applies a thinking level (Prime wire names: off, minimal, low, medium, high, xhigh, max).
/// Prime clamps it to what the session model supports.
pub async fn set_thinking_level(socket: &std::path::Path, session_id: &str, level: &str) -> Result<()> {
    call(
        socket,
        json!({"type":"set_thinking_level","activeSessionId":session_id,"level":level}),
        Duration::from_secs(30),
        |_| {},
    )
    .await
    .map(|_| ())
}

/// A Claake Code model Prime's offline catalog does not know yet. The daemon runs with
/// `PI_OFFLINE=1`, so its catalog stays at the pinned build: newer models are declared through
/// Prime's own `models.json` under the built-in provider, which supplies the API and base URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDeclaration {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    /// Wire value sent for `max` (some providers only accept up to `xhigh`).
    pub max_effort: String,
    pub images: bool,
    pub context_window: u64,
    pub max_tokens: u64,
}

fn declaration_json(model: &ModelDeclaration) -> Value {
    let mut value = json!({
        "id": model.id,
        "name": model.name,
        "reasoning": model.reasoning,
        "input": if model.images { json!(["text", "image"]) } else { json!(["text"]) },
        "contextWindow": model.context_window.max(1),
        "maxTokens": model.max_tokens.max(1),
    });
    if model.reasoning {
        // `off` stays unmapped: each provider sends its own "no reasoning" value.
        // xhigh/max must be mapped explicitly or Prime treats them as unsupported.
        value["thinkingLevelMap"] = json!({
            "minimal": "low", "low": "low", "medium": "medium", "high": "high",
            "xhigh": "xhigh", "max": model.max_effort,
        });
    }
    value
}

/// Adds or replaces one model in Prime's `models.json`, keeping every other entry (other RLM
/// chats and Prime's remembered default model may rely on them). Unreadable content is replaced.
/// Prime rebuilds its registry on every model resolution, so a running daemon picks it up.
pub fn declare_model(agent_dir: &std::path::Path, model: &ModelDeclaration) -> Result<()> {
    std::fs::create_dir_all(agent_dir).context("create Prime agent dir")?;
    let target = agent_dir.join("models.json");
    let mut document = std::fs::read(&target)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|doc| doc["providers"].is_object())
        .unwrap_or_else(|| json!({"providers": {}}));
    let provider = &mut document["providers"][model.provider.as_str()];
    if !provider["models"].is_array() {
        provider["models"] = json!([]);
    }
    let list = provider["models"].as_array_mut().expect("models is an array");
    list.retain(|entry| entry["id"] != model.id.as_str());
    list.push(declaration_json(model));
    let temp = agent_dir.join(".models.json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(&document)?).context("write Prime models file")?;
    std::fs::rename(&temp, &target).context("install Prime models file")?;
    Ok(())
}

/// Returns the response `data`. Session events arriving before the response are dropped:
/// the attach snapshot already covers them.
async fn wait_response(connection: &mut Connection, id: &str) -> Result<Value> {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(30), connection.receive())
            .await.context("Prime attach timed out")??;
        if frame["type"] == "response" && frame["id"] == id {
            if frame["success"] != true { bail!("{}", rejection("attach", &frame)); }
            return Ok(frame["data"].clone());
        }
    }
}

/// What an attach response says about the session (daemon protocol v7).
#[derive(Debug, Clone, PartialEq)]
pub struct AttachSnapshot {
    pub generation: Option<String>,
    pub last_sequence: u64,
    /// Prime never replays missed events: `false` means events were lost and the
    /// snapshot is the only source of truth for the gap.
    pub replay_complete: bool,
    pub streaming: bool,
    /// Last message of the transcript, when it is an assistant message.
    pub last_assistant: Option<Value>,
}

pub fn parse_attach(data: &Value) -> AttachSnapshot {
    let snapshot = &data["snapshot"];
    let last_sequence = snapshot["lastEventSequence"].as_u64()
        .or_else(|| data["lastEventSequence"].as_u64()).unwrap_or(0);
    let cursor = if snapshot["lastEventCursor"].is_object() { &snapshot["lastEventCursor"] } else { &data["lastEventCursor"] };
    let messages = snapshot["messages"].as_array().or_else(|| data["messages"].as_array());
    AttachSnapshot {
        generation: cursor["generation"].as_str().map(str::to_string),
        last_sequence,
        replay_complete: data["replay"]["status"] == "complete",
        streaming: snapshot["state"]["isStreaming"].as_bool().unwrap_or(false),
        last_assistant: messages.and_then(|m| m.last()).filter(|m| m["role"] == "assistant").cloned(),
    }
}

fn stop_error(message: &Value) -> Option<String> {
    match message["stopReason"].as_str().unwrap_or_default() {
        "aborted" => Some("aborted".into()),
        "error" => Some(format!("Prime run failed: {}", error_category(message["errorMessage"].as_str().unwrap_or("")))),
        _ => None,
    }
}

const MAX_RECONNECTS: u32 = 3;

/// Sends one prompt and streams `AgentEvent`s until the run ends. Replayed (historic) events are dropped.
/// Send a prompt and wait for the daemon's settled queue, not an intermediate agent_end.
pub async fn run_prompt(
    socket: &std::path::Path, session_id: &str, text: &str, max_idle: Duration,
    on_event: impl FnMut(crate::AgentEvent),
) -> Result<()> {
    drive_session(socket, session_id, Some(text), max_idle, None, on_event).await
}

/// Retain the attach while idle so background completions and continuations stay visible.
pub async fn observe_session(
    socket: &std::path::Path, session_id: &str,
    ready: tokio::sync::oneshot::Sender<()>,
    on_event: impl FnMut(crate::AgentEvent),
) -> Result<()> {
    drive_session(socket, session_id, None, Duration::from_secs(30 * 60), Some(ready), on_event).await
}

async fn drive_session(
    socket: &std::path::Path, session_id: &str, text: Option<&str>, max_idle: Duration,
    mut ready: Option<tokio::sync::oneshot::Sender<()>>,
    mut on_event: impl FnMut(crate::AgentEvent),
) -> Result<()> {
    let retained = text.is_none();
    let mut connection = Connection::connect(socket).await?;
    let attach = connection.send(json!({"type":"attach","activeSessionId":session_id})).await?;
    let initial = parse_attach(&wait_response(&mut connection, &attach).await?);
    let mut generation = initial.generation;
    let mut prompt = if let Some(text) = text {
        Some(connection.send(json!({"type":"prompt","activeSessionId":session_id,"message":text})).await?)
    } else { None };
    let mut stream = RlmStream::starting_after(initial.last_sequence);
    let mut active = initial.streaming;
    if active { on_event(crate::AgentEvent::TurnStarted); }
    let mut settlement: Option<String> = if active {
        Some(connection.send(json!({"type":"wait_for_headless_completion",
            "activeSessionId":session_id,"waitForRlmQuiescence":true})).await?)
    } else { None };
    let mut terminal = None;
    let mut reconnects = 0;
    if let Some(ready) = ready.take() { let _ = ready.send(()); }
    loop {
        let received = if retained && !active { Ok(connection.receive().await) }
            else { tokio::time::timeout(max_idle, connection.receive()).await };
        let frame = match received {
            Err(_) => bail!("Prime run stalled; outcome unknown"),
            Ok(Ok(frame)) => frame,
            Ok(Err(err)) => {
                reconnects += 1;
                if reconnects > MAX_RECONNECTS {
                    return Err(err.context("Prime connection lost; outcome unknown"));
                }
                tokio::time::sleep(Duration::from_millis(200 * u64::from(reconnects))).await;
                let Ok(mut fresh) = Connection::connect(socket).await else { continue };
                let cursor = json!({"activeSessionId":session_id,"generation":generation,
                    "sequence":stream.last_sequence().unwrap_or(initial.last_sequence)});
                let Ok(id) = fresh.send(json!({"type":"attach","activeSessionId":session_id,"resumeCursor":cursor})).await else { continue };
                let snapshot = match wait_response(&mut fresh, &id).await {
                    Ok(data) => parse_attach(&data), Err(_) => continue,
                };
                if snapshot.generation.is_some() && generation.is_some() && snapshot.generation != generation {
                    bail!("Prime daemon restarted during the run; outcome unknown");
                }
                generation = snapshot.generation.clone().or(generation);
                connection = fresh;
                settlement = None;
                let (events, ended) = stream.resync(&snapshot);
                for event in events { on_event(event); }
                if ended {
                    active = false;
                    if !retained { return Ok(()); }
                } else {
                    active = true;
                    settlement = Some(connection.send(json!({"type":"wait_for_headless_completion",
                        "activeSessionId":session_id,"waitForRlmQuiescence":true})).await?);
                }
                continue;
            }
        };
        if frame["type"] == "response" {
            let id = frame["id"].as_str();
            if prompt.as_deref() == id && prompt.is_some() {
                if frame["success"] != true { bail!("{}", rejection("prompt", &frame)); }
                prompt = None;
                continue;
            }
            if settlement.as_deref() == id && settlement.is_some() {
                if frame["success"] != true { bail!("{}", rejection("wait_for_headless_completion", &frame)); }
                settlement = None;
                if active {
                    for event in stream.push(PrimeEnvelope { session_id: session_id.to_string(),
                        sequence: None, replayed: false, event: PrimeEvent::TurnEnded { error: terminal.take() } }) {
                        on_event(event);
                    }
                    active = false;
                }
                if !retained { return Ok(()); }
                continue;
            }
        }
        let Some(envelope) = map_session_event(&frame) else { continue };
        if envelope.replayed || envelope.session_id != session_id { continue; }
        if envelope.sequence.is_some_and(|seq| stream.last_sequence().is_some_and(|last| seq <= last)) { continue; }
        match &envelope.event {
            PrimeEvent::TurnStarted => {
                terminal = None;
                if active { continue; }
                active = true;
            }
            PrimeEvent::TurnEnded { error } => {
                terminal = error.clone();
                // Consume the boundary sequence without publishing a false terminal to Claake.
                stream.last_sequence = envelope.sequence.or(stream.last_sequence);
                if settlement.is_none() {
                    settlement = Some(connection.send(json!({"type":"wait_for_headless_completion",
                        "activeSessionId":session_id,"waitForRlmQuiescence":true})).await?);
                }
                continue;
            }
            _ => {}
        }
        for event in stream.push(envelope) { on_event(event); }
    }
}

/// Read-only view of Prime's persistent Python environment (the kernel venv), for Settings.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonEnvStatus {
    pub venv_path: String,
    /// False until Prime boots its first kernel (the venv is created lazily).
    pub installed: bool,
    pub python_version: Option<String>,
    pub packages: Vec<PythonPackage>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
pub struct PythonPackage {
    pub name: String,
    pub version: String,
}

/// Inspects a standard venv on disk (`pyvenv.cfg` + `*.dist-info`). Never runs Python.
pub fn inspect_python_env(venv: &std::path::Path) -> PythonEnvStatus {
    let cfg = std::fs::read_to_string(venv.join("pyvenv.cfg")).ok();
    let python_version = cfg.as_deref().and_then(|cfg| {
        cfg.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            matches!(key.trim(), "version" | "version_info").then(|| value.trim().to_string())
        })
    });
    // Unix: lib/pythonX.Y/site-packages ; Windows: Lib/site-packages.
    let mut sites = vec![venv.join("Lib").join("site-packages")];
    if let Ok(entries) = std::fs::read_dir(venv.join("lib")) {
        sites.extend(entries.flatten().map(|e| e.path().join("site-packages")));
    }
    let mut packages = Vec::new();
    for site in sites {
        let Ok(items) = std::fs::read_dir(&site) else { continue };
        for item in items.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            if let Some((pkg, version)) = name.strip_suffix(".dist-info").and_then(|stem| stem.rsplit_once('-')) {
                packages.push(PythonPackage { name: pkg.replace('_', "-"), version: version.to_string() });
            }
        }
    }
    packages.sort();
    packages.dedup();
    PythonEnvStatus {
        venv_path: venv.display().to_string(),
        installed: cfg.is_some(),
        python_version,
        packages,
        size_bytes: dir_size(venv),
    }
}

fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if !meta.is_dir() { return meta.len(); }
    std::fs::read_dir(path).map(|entries| entries.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0)
}

/// One credential handed to Prime through `agentDir/auth.json`.
#[derive(Debug, Clone, PartialEq)]
pub enum PrimeCredential {
    ApiKey(String),
    /// Access token only: the refresh token stays with Claake Code, which refreshes before each
    /// turn. Giving Prime the refresh token would let it rotate it behind Claake's back.
    OAuth { access: String, expires_ms: i64, account_id: Option<String> },
}

/// Writes Prime's credential store atomically with 0600 permissions. Prime re-reads this file
/// when a cached OAuth credential expires, so a rewrite takes effect without a restart.
pub fn write_auth_file(agent_dir: &std::path::Path, credentials: &[(String, PrimeCredential)]) -> Result<()> {
    std::fs::create_dir_all(agent_dir).context("create Prime agent dir")?;
    let mut document = serde_json::Map::new();
    for (provider, credential) in credentials {
        let value = match credential {
            PrimeCredential::ApiKey(key) => json!({"type":"api_key","key":key}),
            PrimeCredential::OAuth { access, expires_ms, account_id } => {
                let mut value = json!({"type":"oauth","access":access,"refresh":null,"expires":expires_ms});
                if let Some(account) = account_id { value["accountId"] = json!(account); }
                value
            }
        };
        document.insert(provider.clone(), value);
    }
    let target = agent_dir.join("auth.json");
    let temp = agent_dir.join(".auth.json.tmp");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temp).context("open Prime auth file")?;
        file.write_all(serde_json::to_vec_pretty(&Value::Object(document))?.as_slice())?;
        file.sync_all()?;
    }
    std::fs::rename(&temp, &target).context("install Prime auth file")?;
    Ok(())
}

/// Launch parameters. Credentials are injected explicitly; nothing else is inherited.
pub struct SidecarConfig {
    pub binary: std::path::PathBuf,
    /// Private data root (agent dir, socket, kernel venv). Canonicalised on start.
    pub data_dir: std::path::PathBuf,
    pub uv_dir: Option<std::path::PathBuf>,
    pub credentials: Vec<(String, String)>,
}

pub struct Sidecar {
    child: tokio::process::Child,
    pub socket: std::path::PathBuf,
    /// Unix: group created for the supervisor. Windows: the supervisor's pid, root of its tree.
    pgid: Option<u32>,
    /// Workers may detach (Unix), so their identities are snapshotted on stop.
    #[cfg(unix)]
    children: Vec<PrimeProcess>,
}

#[cfg(unix)]
impl Drop for Sidecar {
    fn drop(&mut self) {
        // Workers are separate processes: killing the supervisor alone leaves them holding
        // session leases, and every later `create` is refused. Take the whole group down.
        if let Some(pgid) = self.pgid {
            if matches!(self.child.try_wait(), Ok(None)) {
                self.children.extend(direct_children(pgid));
            }
            if group_runs_prime(pgid, "prime-agent") { kill_group(pgid, "KILL"); }
            kill_recorded_children(&self.children, pgid);
        }
        if let Some(dir) = self.socket.parent() { let _ = std::fs::remove_dir_all(dir); }
    }
}

#[cfg(windows)]
impl Drop for Sidecar {
    fn drop(&mut self) {
        // Workers are children of the supervisor: take the whole tree down while it is alive.
        if let (Some(pid), Ok(None)) = (self.pgid, self.child.try_wait()) { kill_tree(pid); }
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `taskkill /T /F`: the supervisor and every process it started (no Win32 dependency).
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let system = std::env::var_os("SystemRoot").map_or_else(|| "C:\\Windows".into(), std::path::PathBuf::from);
    let _ = std::process::Command::new(system.join("System32").join("taskkill.exe"))
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Signals every process of group `pgid` (no libc dependency). Errors (group gone) are ignored.
#[cfg(unix)]
fn kill_group(pgid: u32, signal: &str) {
    if pgid <= 1 { return; }
    let _ = std::process::Command::new("/bin/kill")
        .args(["-s", signal, "--", &format!("-{pgid}")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// True when group `pgid` still holds a `prime-agent` process (guards against pgid reuse).
#[cfg(unix)]
fn group_runs_prime(pgid: u32, pattern: &str) -> bool {
    pgid > 1
        && std::process::Command::new("/usr/bin/pgrep")
            .args(["-g", &pgid.to_string(), "-f", pattern])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct PrimeProcess {
    pid: u32,
    ppid: u32,
    pgid: u32,
    uid: u32,
    identity: String,
    command: String,
}

#[cfg(unix)]
fn process_info(pid: u32) -> Option<PrimeProcess> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-ww", "-o", "pid=,ppid=,pgid=,uid=,lstart=,command=", "-p", &pid.to_string()])
        .output().ok()?;
    if !output.status.success() { return None; }
    parse_process(&String::from_utf8(output.stdout).ok()?)
}

#[cfg(unix)]
fn parse_process(line: &str) -> Option<PrimeProcess> {
    let mut fields = line.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    let ppid = fields.next()?.parse().ok()?;
    let pgid = fields.next()?.parse().ok()?;
    let uid = fields.next()?.parse().ok()?;
    let mut date = Vec::new();
    for _ in 0..5 { date.push(fields.next()?); }
    let command = fields.collect::<Vec<_>>().join(" ");
    if command.is_empty() { return None; }
    Some(PrimeProcess { pid, ppid, pgid, uid, identity: date.join(" "), command })
}

#[cfg(unix)]
fn matching_pids(args: &[&str]) -> Vec<u32> {
    let Ok(output) = std::process::Command::new("/usr/bin/pgrep").args(args).output() else { return Vec::new(); };
    if !output.status.success() { return Vec::new(); }
    String::from_utf8_lossy(&output.stdout).split_whitespace()
        .filter_map(|s| s.parse::<u32>().ok()).filter(|p| *p > 1).collect()
}

#[cfg(unix)]
fn direct_children(pid: u32) -> Vec<PrimeProcess> {
    matching_pids(&["-P", &pid.to_string()]).into_iter()
        .filter_map(process_info).filter(|p| p.ppid == pid).collect()
}

#[cfg(unix)]
fn kill_recorded_children(children: &[PrimeProcess], supervisor: u32) {
    for saved in children {
        let Some(current) = process_info(saved.pid) else { continue; };
        // Check start time, owner and command again: never signal a reused PID.
        if current.identity == saved.identity && current.uid == saved.uid
            && current.command == saved.command && (current.ppid == supervisor || current.ppid == 1)
        {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-s", "KILL", "--", &current.pid.to_string()]).status();
        }
    }
}

/// Only Claake's supervisor command can authorize orphan cleanup, not a detached worker.
#[cfg(unix)]
fn orphan_socket(process: &PrimeProcess, uid: u32) -> Option<std::path::PathBuf> {
    if process.ppid != 1 || process.pid != process.pgid || process.pgid <= 1 || process.uid != uid {
        return None;
    }
    // The executable path may contain spaces (e.g. Claake Code.app).
    let (executable, arguments) = process.command.split_once(" --mode ")?;
    if std::path::Path::new(executable).file_name()? != "prime-agent" { return None; }
    let args: Vec<_> = arguments.split_whitespace().collect();
    if args.first().copied() != Some("daemon") { return None; }
    let index = args.iter().position(|a| *a == "--daemon-socket")?;
    let socket = std::path::PathBuf::from(*args.get(index + 1)?);
    let dir = socket.parent()?;
    let name = dir.file_name()?.to_str()?.strip_prefix("ccp-")?;
    if socket.file_name()? != "d.sock" || name.len() != 12 || !name.bytes().all(|b| b.is_ascii_hexdigit())
        || !matches!(dir.parent()?.to_str()?, "/tmp" | "/private/tmp")
    { return None; }
    Some(socket)
}

#[cfg(unix)]
fn cleanup_orphans(root: &std::path::Path) {
    use std::os::unix::fs::MetadataExt;
    let Ok(metadata) = std::fs::metadata(root) else { return; };
    for pid in matching_pids(&["-P", "1", "-f", "prime-agent"]) {
        let Some(process) = process_info(pid) else { continue; };
        let Some(socket) = orphan_socket(&process, metadata.uid()) else { continue; };
        let Some(dir) = socket.parent() else { continue; };
        let Ok(dir_metadata) = std::fs::symlink_metadata(dir) else { continue; };
        if !dir_metadata.is_dir() || dir_metadata.uid() != metadata.uid() || dir_metadata.mode() & 0o077 != 0 { continue; }
        let children = direct_children(pid);
        // Recheck immediately before signaling; errors and changed ownership fail closed.
        if process_info(pid).as_ref() != Some(&process) { continue; }
        if !group_runs_prime(process.pgid, "prime-agent") { continue; }
        tracing::warn!(pgid = process.pgid, "killing orphaned Claake Prime group");
        kill_group(process.pgid, "KILL");
        kill_recorded_children(&children, pid);
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Minimal environment: telemetry off, private HOME-independent state, no ambient secrets.
pub fn sidecar_env(config: &SidecarConfig, root: &std::path::Path) -> Vec<(String, String)> {
    let mut path: Vec<String> = config.uv_dir.iter().map(|uv| uv.display().to_string()).collect();
    path.extend(system_path());
    let separator = if cfg!(windows) { ";" } else { ":" };
    let mut env = vec![
        ("PATH".into(), path.join(separator)),
        ("HOME".into(), root.display().to_string()),
        ("PRIME_AGENT_CODING_AGENT_DIR".into(), root.join("agent").display().to_string()),
        ("PRIME_AGENT_KERNEL_VENV".into(), root.join("kernel-venv").display().to_string()),
        ("PRIME_AGENT_TELEMETRY".into(), "0".into()),
        ("DO_NOT_TRACK".into(), "1".into()),
        ("PI_OFFLINE".into(), "1".into()),
    ];
    #[cfg(windows)]
    env.extend(windows_env(root));
    if let Some(dir) = package_dir(&config.binary) {
        env.push(("PI_PACKAGE_DIR".into(), dir.display().to_string()));
    }
    env.extend(config.credentials.iter().cloned());
    env
}

#[cfg(unix)]
fn system_path() -> Vec<String> {
    ["/usr/bin", "/bin", "/usr/local/bin"].map(String::from).to_vec()
}

#[cfg(windows)]
fn system_path() -> Vec<String> {
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    vec![format!(r"{system}\System32"), system.clone(), format!(r"{system}\System32\Wbem")]
}

/// Windows needs a few system variables (Python's Winsock init reads SystemRoot; Prime finds
/// Git Bash under ProgramFiles). Profile and temp folders point into the private root, like HOME:
/// Python's `Path.home()` reads USERPROFILE, uv keeps its cache and Pythons under LOCALAPPDATA.
#[cfg(windows)]
fn windows_env(root: &std::path::Path) -> Vec<(String, String)> {
    const PASSTHROUGH: [&str; 12] = [
        "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "ProgramFiles",
        "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE", "USERNAME",
    ];
    let mut env: Vec<(String, String)> = PASSTHROUGH
        .iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name.to_string(), value)))
        .collect();
    let temp = root.join("tmp");
    let _ = std::fs::create_dir_all(&temp);
    for (name, dir) in [
        ("USERPROFILE", root.to_path_buf()),
        ("LOCALAPPDATA", root.join("AppData").join("Local")),
        ("APPDATA", root.join("AppData").join("Roaming")),
        ("TEMP", temp.clone()),
        ("TMP", temp),
    ] {
        env.push((name.into(), dir.display().to_string()));
    }
    env
}

/// Where Prime finds `prime-agent-runtime` (the Python sources of its kernel) when it is not
/// next to the binary: the bundle ships it as a resource. `None` keeps Prime's own lookup
/// (next to its executable).
fn package_dir(binary: &std::path::Path) -> Option<std::path::PathBuf> {
    let has_runtime = |dir: &std::path::Path| dir.join("prime-agent-runtime").join("pyproject.toml").is_file();
    let exe_dir = binary.parent()?;
    if has_runtime(exe_dir) {
        return None;
    }
    // macOS: Contents/Resources/prime. Windows installs the resources next to the executable.
    let mut candidates = vec![exe_dir.join("prime")];
    if let Some(contents) = exe_dir.parent() { candidates.insert(0, contents.join("Resources").join("prime")); }
    candidates.into_iter().find(|dir| has_runtime(dir))
}

/// Private data root as Prime sees it. Prime canonicalises paths: /tmp -> /private/tmp on macOS
/// breaks lease ownership otherwise.
fn data_root(dir: &std::path::Path) -> Result<std::path::PathBuf> {
    std::fs::create_dir_all(dir)?;
    Ok(plain_path(std::fs::canonicalize(dir)?))
}

/// Windows canonical paths are verbatim (`\\?\C:\...`), which Python, uv and git handle badly
/// (`git worktree add` fails with "Invalid argument"): keep the ordinary drive form.
/// Other paths are returned unchanged.
pub fn plain_path(path: std::path::PathBuf) -> std::path::PathBuf {
    #[cfg(windows)]
    if let Some(rest) = path.to_str().and_then(|p| p.strip_prefix(r"\\?\")) {
        if rest.as_bytes().get(1) == Some(&b':') { return rest.into(); }
    }
    path
}

/// A fresh daemon endpoint for this run.
/// Unix: AF_UNIX paths are capped (~104 bytes) and app data dirs exceed it on macOS, so a short
/// per-run directory owned by the user (0700). Windows: a named pipe with a random name.
#[cfg(unix)]
fn new_endpoint() -> Result<std::path::PathBuf> {
    use std::os::unix::fs::DirBuilderExt;
    let socket_dir = std::path::PathBuf::from("/tmp").join(format!("ccp-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
    std::fs::DirBuilder::new().mode(0o700).create(&socket_dir)?;
    let socket = std::fs::canonicalize(socket_dir)?.join("d.sock");
    if socket.as_os_str().len() > 100 { bail!("Prime socket path too long"); }
    Ok(socket)
}

#[cfg(windows)]
fn new_endpoint() -> Result<std::path::PathBuf> {
    Ok(format!(r"\\.\pipe\claake-prime-{}", uuid::Uuid::new_v4().simple()).into())
}

/// Kills the supervisor's family after a failed start.
fn kill_family(id: u32) {
    #[cfg(unix)]
    kill_group(id, "KILL");
    #[cfg(windows)]
    kill_tree(id);
}

impl Sidecar {
    pub async fn start(config: &SidecarConfig) -> Result<Self> {
        let root = data_root(&config.data_dir)?;
        let socket = new_endpoint()?;
        // Never contact the shared legacy marker: it may name another live app's daemon.
        let _ = std::fs::remove_file(root.join("daemon.socket"));
        #[cfg(unix)]
        cleanup_orphans(&root);
        // Supervisor output may echo prompts: keep it private to the data dir (0600 on unix).
        let log_path = root.join("supervisor.log");
        let log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&log_path, std::fs::Permissions::from_mode(0o600))?;
        }
        let mut command = tokio::process::Command::new(&config.binary);
        command
            .args(["--mode", "daemon", "--daemon-socket"])
            .arg(&socket)
            .env_clear()
            .envs(sidecar_env(config, &root))
            .current_dir(&root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(log.try_clone()?))
            .stderr(std::process::Stdio::from(log))
            .kill_on_drop(true);
        // Own process group so a hard stop can target the whole family.
        #[cfg(unix)]
        command.process_group(0);
        // A hidden console, inherited by the workers, Python and uv: no window flashes.
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().context("spawn Prime sidecar")?;
        let pgid = child.id();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if open_stream(&socket).await.is_ok() {
                #[cfg(unix)]
                return Ok(Self { child, socket, pgid, children: Vec::new() });
                #[cfg(windows)]
                return Ok(Self { child, socket, pgid });
            }
            if child.try_wait()?.is_some() { bail!("Prime sidecar exited during startup"); }
            if tokio::time::Instant::now() > deadline {
                if let Some(id) = pgid { kill_family(id); }
                let _ = child.kill().await;
                bail!("Prime sidecar socket unavailable");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// One total grace period for both the shutdown request and supervisor exit.
    pub async fn stop(mut self) -> Result<()> {
        #[cfg(unix)]
        if let Some(pid) = self.pgid { self.children = direct_children(pid); }
        let graceful = async {
            let _ = call(&self.socket, json!({"type":"shutdown"}), Duration::from_secs(3), |_| {}).await;
            let _ = self.child.wait().await;
        };
        let _ = tokio::time::timeout(Duration::from_secs(3), graceful).await;
        // Do not await another unbounded drain. Drop guards the group and detached children.
        #[cfg(windows)]
        if let (Some(pid), Ok(None)) = (self.pgid, self.child.try_wait()) { kill_tree(pid); }
        let _ = self.child.start_kill();
        Ok(())
    }
}

/// True when a daemon answers on `socket` (liveness probe, no command sent).
pub async fn daemon_alive(socket: &std::path::Path) -> bool {
    open_stream(socket).await.is_ok()
}


#[cfg(all(test, unix))]
#[path = "prime_lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn orphan_cleanup_rejects_live_apps_workers_and_unrelated_paths() {
        let original = parse_process("123 1 123 501 Mon Nov 17 12:00:00 2025 /Applications/Claake Code.app/Contents/MacOS/prime-agent --mode daemon --daemon-socket /private/tmp/ccp-abcdef012345/d.sock").unwrap();
        assert!(orphan_socket(&original, 501).is_some());
        for (ppid, pgid, uid) in [(42, 123, 501), (1, 99, 501), (1, 1, 501), (1, 123, 502)] {
            let p = PrimeProcess { ppid, pgid, uid, ..original.clone() };
            assert!(orphan_socket(&p, 501).is_none());
        }
        for path in ["/tmp/other/d.sock", "/tmp/ccp-abcdef012345/../d.sock", "/home/ccp-abcdef012345/d.sock"] {
            let p = PrimeProcess { command: format!("prime-agent --mode daemon --daemon-socket {path}"), ..original.clone() };
            assert!(orphan_socket(&p, 501).is_none());
        }
        assert!(parse_process("invalid").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn kill_group_stops_supervisor_and_children() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & sleep 30"]).process_group(0).spawn().unwrap();
        let pgid = child.id();
        // A guard also cleans up when an assertion fails.
        struct Guard(u32);
        impl Drop for Guard { fn drop(&mut self) { kill_group(self.0, "KILL"); } }
        let _guard = Guard(pgid);
        std::thread::sleep(Duration::from_millis(100));
        assert!(group_runs_prime(pgid, "sleep 30"));
        kill_group(pgid, "KILL");
        child.wait().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while group_runs_prime(pgid, ".") && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!group_runs_prime(pgid, "."));
        assert!(!group_runs_prime(0, "."));
        assert!(!group_runs_prime(1, "."));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_is_bounded_when_shutdown_does_not_reply() {
        let dir = std::path::PathBuf::from("/tmp").join(format!("ccp-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
        std::fs::create_dir(&dir).unwrap();
        let socket = dir.join("d.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let mut command = tokio::process::Command::new("/bin/sleep");
        command.arg("30").process_group(0).kill_on_drop(true);
        let child = command.spawn().unwrap();
        let pgid = child.id();
        let sidecar = Sidecar { child, socket, pgid, children: Vec::new() };
        let started = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(5), sidecar.stop()).await.unwrap().unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!dir.exists());
        server.abort();
    }

    #[test]
    fn package_dir_points_to_bundled_runtime() {
        let app = std::env::temp_dir().join(format!("cc-prime-pkg-{}", uuid::Uuid::new_v4()));
        let binary = app.join("MacOS").join("prime-agent");
        std::fs::create_dir_all(app.join("MacOS")).unwrap();
        assert_eq!(package_dir(&binary), None);
        let resources = app.join("Resources").join("prime");
        std::fs::create_dir_all(resources.join("prime-agent-runtime")).unwrap();
        std::fs::write(resources.join("prime-agent-runtime").join("pyproject.toml"), "").unwrap();
        assert_eq!(package_dir(&binary), Some(resources));
        // Next to the binary (dev build): Prime finds it alone.
        std::fs::create_dir_all(app.join("MacOS").join("prime-agent-runtime")).unwrap();
        std::fs::write(app.join("MacOS").join("prime-agent-runtime").join("pyproject.toml"), "").unwrap();
        assert_eq!(package_dir(&binary), None);
        let _ = std::fs::remove_dir_all(app);
    }

    #[test]
    fn sidecar_env_is_minimal_and_private() {
        let config = SidecarConfig {
            binary: "prime-agent".into(), data_dir: "/data".into(),
            uv_dir: Some("/opt/uv".into()),
            credentials: vec![("ANTHROPIC_API_KEY".into(), "k".into())],
        };
        let env = sidecar_env(&config, std::path::Path::new("/data"));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("PRIME_AGENT_TELEMETRY"), Some("0"));
        assert_eq!(get("DO_NOT_TRACK"), Some("1"));
        assert_eq!(get("HOME"), Some("/data"));
        assert!(get("PATH").unwrap().starts_with("/opt/uv:"));
        assert_eq!(get("ANTHROPIC_API_KEY"), Some("k"));
        assert!(get("SSH_AUTH_SOCK").is_none());
        assert!(get("PI_PACKAGE_DIR").is_none());
    }
    fn session_event(event: Value) -> Value {
        json!({"type":"session_event","activeSessionId":"s1","meta":{"sequence":7,"replayed":true},"event":event})
    }
    #[test]
    fn maps_captured_turn_events() {
        let reply = json!({"role":"assistant","content":[{"type":"text","text":"Bonjour monde"}]});
        let update = map_session_event(&session_event(json!({"type":"message_update","message":reply}))).unwrap();
        assert_eq!(update.event, PrimeEvent::AssistantText { text: "Bonjour monde".into() });
        assert_eq!((update.session_id.as_str(), update.sequence, update.replayed), ("s1", Some(7), true));
        // User echoes must not be rendered as assistant output.
        let user = json!({"role":"user","content":[{"type":"text","text":"salut"}]});
        assert_eq!(map_session_event(&session_event(json!({"type":"message_end","message":user}))).unwrap().event,
            PrimeEvent::Other("message_end".into()));
        let end = json!({"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop"}]});
        assert_eq!(map_session_event(&session_event(end)).unwrap().event, PrimeEvent::TurnEnded { error: None });
    }
    #[test]
    fn failed_or_aborted_run_is_not_success() {
        let end = json!({"type":"agent_end","messages":[{"role":"assistant","stopReason":"aborted"}]});
        assert_eq!(map_session_event(&session_event(end)).unwrap().event,
            PrimeEvent::TurnEnded { error: Some("aborted".into()) });
        assert!(map_session_event(&json!({"type":"response"})).is_none());
    }
    fn env(sequence: u64, event: PrimeEvent) -> PrimeEnvelope {
        PrimeEnvelope { session_id: "s".into(), sequence: Some(sequence), replayed: false, event }
    }
    #[test]
    fn stream_emits_deltas_and_drops_replayed_sequences() {
        use crate::AgentEvent as E;
        let mut stream = RlmStream::default();
        let text = |t: &str| PrimeEvent::AssistantText { text: t.into() };
        assert!(matches!(stream.push(env(1, PrimeEvent::TurnStarted)).as_slice(), [E::TurnStarted]));
        let first = stream.push(env(2, text("Bon")));
        assert!(matches!(first.as_slice(), [E::TextStarted, E::TextChunk { delta }] if delta == "Bon"));
        assert!(matches!(stream.push(env(3, text("Bonjour"))).as_slice(), [E::TextChunk { delta }] if delta == "jour"));
        // Replay after resync, and the identical final message_end text, add nothing.
        assert!(stream.push(env(3, text("Bonjour"))).is_empty());
        assert!(stream.push(env(4, text("Bonjour"))).is_empty());
        assert!(matches!(stream.push(env(5, PrimeEvent::TurnEnded { error: None })).as_slice(),
            [E::TextFinished, E::TurnFinished { .. }]));
    }
    #[test]
    fn stream_maps_abort_and_error_to_non_success() {
        use crate::AgentEvent as E;
        let mut stream = RlmStream::default();
        assert!(matches!(stream.push(env(1, PrimeEvent::TurnEnded { error: Some("aborted".into()) })).as_slice(), [E::Interrupted]));
        assert!(matches!(stream.push(env(2, PrimeEvent::TurnEnded { error: Some("boom".into()) })).as_slice(),
            [E::Error { message }] if message == "boom"));
    }
    #[test]
    fn envelope_matches_v7() {
        let frame = command_frame("test", json!({"type":"abort","activeSessionId":"root"})).unwrap();
        assert_eq!(frame["protocol"]["version"], 7);
        assert_eq!(frame["command"]["activeSessionId"], "root");
        assert!(command_frame("test", json!({})).is_err());
    }
    #[cfg(unix)]
    async fn mock_response(payload: Vec<u8>) -> String {
        use tokio::net::UnixListener;
        let path = std::env::temp_dir().join(format!("cc-prime-{}.sock", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut line = String::new();
            BufReader::new(reader).read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let payload = String::from_utf8(payload).unwrap().replace("REQUEST_ID", request["id"].as_str().unwrap());
            let _ = writer.write_all(payload.as_bytes()).await;
        });
        let error = call(&path, json!({"type":"list"}), Duration::from_secs(2), |_| {}).await.unwrap_err().to_string();
        server.await.unwrap();
        std::fs::remove_file(path).unwrap();
        error
    }

    #[test]
    fn diagnostics_never_echo_arbitrary_upstream_content() {
        for secret in ["k", "SECRET_API_KEY", "private words", "/private/path", "é秘密"] {
            let error = rejection(secret, &json!({"error":{"message":secret}}));
            assert_eq!(error, "Prime daemon rejected command `unknown`: unclassified failure (upstream details withheld)");
            let message = json!({"stopReason":"error","errorMessage":secret});
            assert_eq!(stop_error(&message).as_deref(), Some("Prime run failed: unclassified failure (upstream details withheld)"));
            assert_eq!(stop_error(&json!({"stopReason":"aborted","errorMessage":secret})).as_deref(), Some("aborted"));
        }
        assert_eq!(rejection("set_model", &json!({"error":"Model not found: SECRET"})),
            "Prime daemon rejected command `set_model`: model unavailable");
        assert_eq!(error_category("No API key found for SECRET"), "provider authentication unavailable");
        assert_eq!(error_category("Unknown active session: SECRET"), "session unavailable");
        assert!(error_category("Session file /SECRET.jsonl is already active in abc — open elsewhere").starts_with("session already open"));
        assert!(!error_category("Session file /SECRET.jsonl is already active in abc").contains("SECRET"));
        let duplicate = rejection("create", &json!({"error": "Agent name \"SECRET\" is unavailable: an agent of that name already exists at depth 0 under this parent"}));
        assert_eq!(duplicate, "Prime daemon rejected command `create`: another Prime session already uses this name");
        assert!(!duplicate.contains("SECRET"));
        let refused = rejection("create", &json!({
            "error": "This session is currently open in another process (active in x) SECRET",
            "errorInfo": {"code": "session_already_active", "sessionPath": "/SECRET"}
        }));
        assert!(refused.contains("session already open") && !refused.contains("SECRET"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_failure_without_leaking_error_content() {
        let error = mock_response(b"{\"type\":\"response\",\"id\":\"REQUEST_ID\",\"success\":false,\"error\":\"SECRET_API_KEY\"}\n".to_vec()).await;
        assert_eq!(error, "Prime daemon rejected command `list`: unclassified failure (upstream details withheld)");
        assert!(!error.contains("SECRET"));
    }

    fn snapshot(streaming: bool, complete: bool, seq: u64, text: &str, stop: &str) -> AttachSnapshot {
        parse_attach(&json!({
            "replay": {"status": if complete { "complete" } else { "unavailable" }},
            "snapshot": {"lastEventSequence": seq, "lastEventCursor": {"generation":"g1","sequence":seq},
                "state": {"isStreaming": streaming},
                "messages": [{"role":"user","content":"q"},
                    {"role":"assistant","stopReason":stop,"content":[{"type":"text","text":text}]}]}
        }))
    }

    #[test]
    fn parses_attach_snapshot() {
        let s = snapshot(true, false, 9, "hi", "stop");
        assert_eq!((s.generation.as_deref(), s.last_sequence, s.replay_complete, s.streaming), (Some("g1"), 9, false, true));
        assert!(s.last_assistant.is_some());
    }

    #[test]
    fn resync_finishes_turn_with_missing_suffix_only() {
        use crate::AgentEvent as E;
        let mut stream = RlmStream::starting_after(3);
        let mut shown = Vec::new();
        shown.extend(stream.push(env(4, PrimeEvent::AssistantText { text: "Hel".into() })));
        shown.extend(stream.push(env(5, PrimeEvent::ToolStarted { id: "t".into(), name: "python".into() })));
        let (events, ended) = stream.resync(&snapshot(false, false, 12, "Hello", "stop"));
        assert!(ended);
        // Text after a tool is a new message: the snapshot's "Hello" is a continuation of "".
        assert!(matches!(events[0], E::ToolFinished { ref id, .. } if id == "t"));
        assert!(events.iter().any(|e| matches!(e, E::TurnFinished { .. })));
        // Events from before the snapshot cursor are dropped afterwards.
        assert!(stream.push(env(12, PrimeEvent::AssistantText { text: "x".into() })).is_empty());
    }

    #[test]
    fn resync_never_duplicates_and_reports_errors() {
        use crate::AgentEvent as E;
        let mut stream = RlmStream::starting_after(0);
        stream.push(env(1, PrimeEvent::AssistantText { text: "Hel".into() }));
        let (events, ended) = stream.resync(&snapshot(false, false, 4, "Hello", "stop"));
        assert!(ended);
        let text: String = events.iter().filter_map(|e| match e { E::TextChunk { delta } => Some(delta.as_str()), _ => None }).collect();
        assert_eq!(text, "lo");
        let mut failed = RlmStream::starting_after(0);
        let (events, _) = failed.resync(&snapshot(false, false, 2, "", "error"));
        assert!(matches!(events.last(), Some(E::Error { .. })));
        // Still running and nothing missed: keep streaming, emit nothing.
        let mut live = RlmStream::starting_after(0);
        let (events, ended) = live.resync(&snapshot(true, true, 0, "", "stop"));
        assert!(events.is_empty() && !ended);
    }

    /// Daemon drops the stream mid-turn; the client reattaches with a resume cursor,
    /// never resends the prompt, and completes the turn from the snapshot.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_prompt_resyncs_after_connection_loss() {
        use tokio::net::UnixListener;
        let path = std::env::temp_dir().join(format!("cc-prime-{}.sock", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let attach_data = |seq: u64, status: &str, streaming: bool, text: &str| json!({
                "replay":{"status":status},
                "snapshot":{"lastEventSequence":seq,"lastEventCursor":{"generation":"g1","sequence":seq},
                    "state":{"isStreaming":streaming},
                    "messages":[{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":text}]}]}});
            // First connection: attach, prompt, one partial event, then drop.
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let attach: Value = serde_json::from_str(&line).unwrap();
            let response = json!({"type":"response","id":attach["id"],"success":true,"data":attach_data(2,"complete",false,"old")});
            writer.write_all(format!("{response}\n").as_bytes()).await.unwrap();
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let prompt: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(prompt["command"]["type"], "prompt");
            let ok = json!({"type":"response","id":prompt["id"],"success":true});
            let partial = json!({"type":"session_event","activeSessionId":"s","meta":{"sequence":3},
                "event":{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hel"}]}}});
            writer.write_all(format!("{ok}\n{partial}\n").as_bytes()).await.unwrap();
            drop(writer);
            drop(reader);
            // Second connection: resume attach only, never a second prompt.
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let resume: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(resume["command"]["type"], "attach");
            assert_eq!(resume["command"]["resumeCursor"]["sequence"], 3);
            assert_eq!(resume["command"]["resumeCursor"]["generation"], "g1");
            let response = json!({"type":"response","id":resume["id"],"success":true,"data":attach_data(9,"unavailable",false,"Hello")});
            writer.write_all(format!("{response}\n").as_bytes()).await.unwrap();
            line.clear();
            // Client must close without sending anything else.
            assert_eq!(reader.read_line(&mut line).await.unwrap(), 0, "unexpected command: {line}");
        });
        let mut events = Vec::new();
        run_prompt(&path, "s", "hi", Duration::from_secs(5), |e| events.push(e)).await.unwrap();
        server.await.unwrap();
        std::fs::remove_file(path).unwrap();
        let text: String = events.iter().filter_map(|e| match e { crate::AgentEvent::TextChunk { delta } => Some(delta.as_str()), _ => None }).collect();
        assert_eq!(text, "Hello");
        assert!(matches!(events.last(), Some(crate::AgentEvent::TurnFinished { .. })));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rlm_create_uses_native_policy_and_requires_persistence() {
        use tokio::net::UnixListener;
        for session_file in [json!("saved.jsonl"), Value::Null, json!("")] {
            let path = std::env::temp_dir().join(format!("cc-prime-{}.sock", uuid::Uuid::new_v4()));
            let listener = UnixListener::bind(&path).unwrap();
            let persisted = session_file == "saved.jsonl";
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let (reader, mut writer) = stream.into_split();
                let mut line = String::new();
                BufReader::new(reader).read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                let command = &request["command"];
                assert_eq!(command["sessionPath"], "reopen.jsonl");
                assert_eq!(command["config"]["appendSystemPrompt"], json!(["native memory policy"]));
                assert!(command["config"].get("harness").is_none());
                assert!(command["config"].get("script").is_none());
                assert!(command["config"].get("systemPrompt").is_none());
                let response = json!({"type":"response","id":request["id"],"success":true,
                    "data":{"activeSessionId":"s","sessionFile":session_file}});
                writer.write_all(format!("{response}\n").as_bytes()).await.unwrap();
            });
            let result = create_rlm_session_with(&path, &std::env::temp_dir(), "memory", Some("reopen.jsonl"), "native memory policy").await;
            assert_eq!(result.is_ok(), persisted);
            if !persisted { assert_eq!(result.unwrap_err().to_string(), "Prime did not provide persisted RLM session"); }
            server.await.unwrap();
            std::fs::remove_file(path).unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_eof_and_oversized_unterminated_frame() {
        assert!(mock_response(Vec::new()).await.contains("disconnected"));
        assert!(mock_response(vec![b'x'; MAX_FRAME_BYTES + 1]).await.contains("frame exceeds limit"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connection_receives_events_after_attach_response() {
        use tokio::net::UnixListener;
        let path = std::env::temp_dir().join(format!("cc-prime-{}.sock", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut line = String::new();
            BufReader::new(reader).read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["command"]["type"], "attach");
            let response = json!({"type":"response","id":request["id"],"success":true});
            // Two frames in one write: the reader must preserve the second frame.
            writer.write_all(format!("{response}\n{{\"type\":\"event\",\"sequence\":2}}\n").as_bytes()).await.unwrap();
        });
        let mut connection = Connection::connect(&path).await.unwrap();
        let id = connection.send(json!({"type":"attach","activeSessionId":"root"})).await.unwrap();
        assert_eq!(connection.receive().await.unwrap()["id"], id);
        assert_eq!(connection.receive().await.unwrap()["sequence"], 2);
        server.await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn routes_event_and_correlates_response() {
        use tokio::net::UnixListener;
        let path = std::env::temp_dir().join(format!("cc-prime-{}.sock", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut line = String::new();
            BufReader::new(reader).read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            writer.write_all(b"{\"type\":\"event\",\"sequence\":1}\n").await.unwrap();
            let response = json!({"type":"response","id":request["id"],"success":true,"data":{"ok":true}});
            writer.write_all(format!("{response}\n").as_bytes()).await.unwrap();
        });
        let mut events = Vec::new();
        let result = call(&path, json!({"type":"list"}), Duration::from_secs(2), |event| events.push(event)).await.unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(events.len(), 1);
        server.await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    /// Real-binary check: `PRIME_AGENT_BIN=/path/prime-agent cargo test -p claakecode-app prime -- --ignored`
    #[test]
    fn inspects_venv_without_running_python() {
        let venv = std::env::temp_dir().join(format!("cc-venv-{}", uuid::Uuid::new_v4()));
        let missing = inspect_python_env(&venv);
        assert!(!missing.installed && missing.packages.is_empty());
        let site = venv.join("lib/python3.12/site-packages");
        std::fs::create_dir_all(site.join("numpy-2.1.0.dist-info")).unwrap();
        std::fs::create_dir_all(site.join("typing_extensions-4.12.2.dist-info")).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), "home = /usr/bin\nversion_info = 3.12.4\n").unwrap();
        let status = inspect_python_env(&venv);
        assert!(status.installed);
        assert_eq!(status.python_version.as_deref(), Some("3.12.4"));
        assert_eq!(status.packages, vec![
            PythonPackage { name: "numpy".into(), version: "2.1.0".into() },
            PythonPackage { name: "typing-extensions".into(), version: "4.12.2".into() },
        ]);
        let _ = std::fs::remove_dir_all(venv);
    }

    #[cfg(unix)]
    #[test]
    fn auth_file_is_private_and_never_carries_refresh_tokens() {
        let dir = std::env::temp_dir().join(format!("cc-prime-auth-{}", uuid::Uuid::new_v4()));
        write_auth_file(&dir, &[
            ("openrouter".into(), PrimeCredential::ApiKey("sk-or".into())),
            ("openai-codex".into(), PrimeCredential::OAuth { access: "at".into(), expires_ms: 42, account_id: Some("acc".into()) }),
        ]).unwrap();
        let path = dir.join("auth.json");
        let doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(doc["openrouter"], json!({"type":"api_key","key":"sk-or"}));
        assert_eq!(doc["openai-codex"], json!({"type":"oauth","access":"at","refresh":null,"expires":42,"accountId":"acc"}));
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt;
          assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600); }
        let _ = std::fs::remove_dir_all(dir);
    }

    fn declaration(provider: &str, id: &str, reasoning: bool) -> ModelDeclaration {
        ModelDeclaration {
            provider: provider.into(), id: id.into(), name: id.into(), reasoning,
            max_effort: "max".into(), images: true, context_window: 200_000, max_tokens: 64_000,
        }
    }

    #[test]
    fn models_file_declares_unknown_models_under_built_in_providers() {
        let dir = std::env::temp_dir().join(format!("cc-prime-models-{}", uuid::Uuid::new_v4()));
        let mut luna = declaration("openai-codex", "gpt-6-luna", true);
        luna.max_effort = "xhigh".into();
        // Unreadable leftovers are replaced, existing entries are kept, same id is replaced.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("models.json"), "not json").unwrap();
        declare_model(&dir, &declaration("anthropic", "claude-haiku-5-5", false)).unwrap();
        declare_model(&dir, &luna).unwrap();
        declare_model(&dir, &declaration("mistral", "devstral-2", false)).unwrap();
        declare_model(&dir, &declaration("anthropic", "claude-haiku-5-5", true)).unwrap();
        let doc: Value = serde_json::from_slice(&std::fs::read(dir.join("models.json")).unwrap()).unwrap();
        assert_eq!(doc["providers"]["anthropic"]["models"].as_array().unwrap().len(), 1);
        let haiku = &doc["providers"]["anthropic"]["models"][0];
        assert_eq!(haiku["id"], "claude-haiku-5-5");
        assert_eq!(haiku["input"], json!(["text", "image"]));
        assert_eq!(haiku["contextWindow"], 200_000);
        // No api/baseUrl: Prime inherits them from the built-in provider.
        assert!(haiku.get("api").is_none() && haiku.get("baseUrl").is_none());
        assert_eq!(haiku["thinkingLevelMap"]["max"], "max");
        // `off` is left to each provider's own "no reasoning" value.
        assert!(haiku["thinkingLevelMap"].get("off").is_none());
        assert_eq!(doc["providers"]["openai-codex"]["models"][0]["thinkingLevelMap"]["max"], "xhigh");
        let devstral = &doc["providers"]["mistral"]["models"][0];
        assert_eq!(devstral["reasoning"], false);
        assert!(devstral.get("thinkingLevelMap").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_catalog_refusals_count_as_unavailable_models() {
        let refused = |raw: &str| anyhow::anyhow!("{}", rejection("set_model", &json!({"error": raw})));
        assert!(is_model_unavailable(&refused("Model not found: anthropic/claude-haiku-5-5")));
        assert!(!is_model_unavailable(&refused("Provider \"anthropic\" is not signed in.")));
        assert!(!is_model_unavailable(&refused("Unknown active session: s1")));
        assert_eq!(
            rejection("set_thinking_level", &json!({"error": "Invalid thinking level \"x\""})),
            "Prime daemon rejected command `set_thinking_level`: invalid session configuration"
        );
    }

    /// Prime must see the providers written to auth.json (API key and OAuth access token alike).
    #[tokio::test]
    #[ignore]
    async fn real_sidecar_reads_auth_file_credentials() {
        let Ok(binary) = std::env::var("PRIME_AGENT_BIN") else { return };
        let dir = std::env::temp_dir().join(format!("cc-prime-auth-it-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = std::fs::canonicalize(&dir).unwrap();
        let far = 4_102_444_800_000_i64; // 2100
        write_auth_file(&root.join("agent"), &[
            ("openrouter".into(), PrimeCredential::ApiKey("sk-or-test".into())),
            ("anthropic".into(), PrimeCredential::OAuth { access: "sk-ant-oat-test".into(), expires_ms: far, account_id: None }),
        ]).unwrap();
        let sidecar = Sidecar::start(&SidecarConfig {
            binary: binary.into(), data_dir: root.clone(), uv_dir: None, credentials: vec![],
        }).await.unwrap();
        let sid = create_session(&sidecar.socket, &root, "auth", None).await.unwrap();
        let refused = set_model(&sidecar.socket, &sid, "anthropic", "SECRET-short").await.unwrap_err().to_string();
        assert_eq!(refused, "Prime daemon rejected command `set_model`: model unavailable");
        assert!(!refused.contains("SECRET"));
        let (native, file) = create_rlm_session_with(&sidecar.socket, &root, "native-memory", None,
            "Use native rlm.harness memory mechanisms; do not claim model-weight training.").await.unwrap();
        assert!(!native.is_empty());
        assert!(file.is_some());
        let models = call(&sidecar.socket, json!({"type":"get_available_models","activeSessionId":sid}),
            Duration::from_secs(30), |_| {}).await.unwrap();
        let text = models.to_string();
        sidecar.stop().await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
        assert!(text.contains("\"openrouter\""), "openrouter missing: {}", &text[..text.len().min(400)]);
        assert!(text.contains("\"anthropic\""), "anthropic missing: {}", &text[..text.len().min(400)]);
    }

    #[tokio::test]
    #[ignore]
    async fn real_sidecar_round_trip_with_faux_provider() {
        let Ok(binary) = std::env::var("PRIME_AGENT_BIN") else { return };
        let dir = std::env::temp_dir().join(format!("cc-prime-it-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = std::fs::canonicalize(&dir).unwrap();
        let script = root.join("script.json");
        std::fs::write(&script, r#"{"engine":"faux","responses":[{"text":"FINAL-TEXT"},{"text":"SECOND"}]}"#).unwrap();
        let sidecar = Sidecar::start(&SidecarConfig {
            binary: binary.into(), data_dir: root.clone(), uv_dir: None, credentials: vec![],
        }).await.unwrap();
        let created = call(&sidecar.socket, json!({"type":"create","name":"it",
            "config":{"cwd":root,"script":script}}), Duration::from_secs(60), |_| {}).await.unwrap();
        let sid = created["activeSessionId"].as_str().unwrap().to_string();
        call(&sidecar.socket, json!({"type":"prompt_and_wait","activeSessionId":sid,"message":"hi"}),
            Duration::from_secs(120), |_| {}).await.unwrap();
        let mut events = Vec::new();
        run_prompt(&sidecar.socket, &sid, "encore", Duration::from_secs(60), |e| events.push(e)).await.unwrap();
        assert!(events.iter().any(|e| matches!(e, crate::AgentEvent::TurnFinished { .. })), "{events:?}");
        let streamed: String = events.iter().filter_map(|e| match e { crate::AgentEvent::TextChunk { delta } => Some(delta.as_str()), _ => None }).collect();
        // Only the new turn: the first turn's replayed text must not leak in.
        assert_eq!(streamed, "SECOND");
        let messages = call(&sidecar.socket, json!({"type":"get_messages","activeSessionId":sid}),
            Duration::from_secs(30), |_| {}).await.unwrap();
        assert!(messages.to_string().contains("FINAL-TEXT"));
        let socket = sidecar.socket.clone();
        sidecar.stop().await.unwrap();
        assert!(call(&socket, json!({"type":"list"}), Duration::from_secs(2), |_| {}).await.is_err());
        // App restart: a new daemon must reopen the same transcript via continueRecent.
        let sidecar = Sidecar::start(&SidecarConfig {
            binary: std::env::var("PRIME_AGENT_BIN").unwrap().into(), data_dir: root.clone(), uv_dir: None, credentials: vec![],
        }).await.unwrap();
        let file = created["sessionFile"].as_str().expect("create returns sessionFile").to_string();
        let (resumed, _) = create_session_with(&sidecar.socket, &root, "it", Some(&script), Some(&file)).await.unwrap();
        let messages = call(&sidecar.socket, json!({"type":"get_messages","activeSessionId":resumed}),
            Duration::from_secs(30), |_| {}).await.unwrap();
        assert!(messages.to_string().contains("FINAL-TEXT"), "resumed session lost history: {messages}");
        sidecar.stop().await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
