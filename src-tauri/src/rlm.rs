//! Tauri commands for the RLM (Prime Agent) chat harness. Prime remains the authority for the
//! session; this layer owns the sidecar lifecycle, credential injection and event relay.
use crate::*;
use claakecode_app::prime::{self, Sidecar, SidecarConfig};

#[derive(Default)]
pub(super) struct RlmRuntime {
    sidecar: Option<Sidecar>,
    /// conversation id -> Prime activeSessionId
    sessions: HashMap<String, String>,
    /// Prime provider ids the running daemon was started with.
    providers: Vec<String>,
}

pub(super) type SharedRlm = Arc<Mutex<RlmRuntime>>;

/// Reuses the providers already signed in to Claake Code (same OAuth logins and API keys as the
/// classic chat). Each OAuth token is refreshed by Claake's own provider code first; Prime only
/// receives the access token. Returns Prime provider id -> credential.
async fn collect_credentials() -> Vec<(String, prime::PrimeCredential)> {
    use prime::PrimeCredential;
    let mut credentials = Vec::new();
    let http = reqwest::Client::new();
    if let Ok(Some(credential)) = claakecode_anthropic::Credential::load_default() {
        if let Ok(access) = credential.bearer_or_key(&http).await {
            let expires_ms = claakecode_anthropic::load_default_auth_status()
                .ok()
                .and_then(|status| status.expires_at_ms)
                .unwrap_or(0);
            credentials.push(("anthropic".to_string(), PrimeCredential::OAuth { access, expires_ms, account_id: None }));
        }
    }
    if let Ok(Some(credential)) = claakecode_openai::Credential::load_default() {
        if let Ok(bearer) = credential.bearer(&http).await {
            if bearer.is_oauth {
                // ChatGPT login = Prime's Codex subscription provider.
                let expires_ms = claakecode_openai::load_default_auth_status()
                    .ok()
                    .and_then(|status| status.expires_at_ms)
                    .unwrap_or(0);
                credentials.push((
                    "openai-codex".to_string(),
                    PrimeCredential::OAuth { access: bearer.token, expires_ms, account_id: bearer.account_id },
                ));
            } else {
                credentials.push(("openai".to_string(), PrimeCredential::ApiKey(bearer.token)));
            }
        }
    }
    if let Ok(Some(key)) = claakecode_openrouter::load_default_api_key() {
        credentials.push(("openrouter".to_string(), PrimeCredential::ApiKey(key)));
    }
    if let Ok(Some(key)) = claakecode_mistral::load_default_api_key() {
        credentials.push(("mistral".to_string(), PrimeCredential::ApiKey(key)));
    }
    credentials
}

fn provider_set(credentials: &[(String, prime::PrimeCredential)]) -> Vec<String> {
    let mut ids: Vec<String> = credentials.iter().map(|(id, _)| id.clone()).collect();
    ids.sort();
    ids
}

/// Maps Claake Code provider ids to Prime ones. Only providers whose credentials can be handed
/// to Prime are accepted; others fail explicitly instead of running on a different model.
fn prime_provider(provider: &str, credentials: &[(String, prime::PrimeCredential)]) -> std::result::Result<&'static str, String> {
    let has = |id: &str| credentials.iter().any(|(p, _)| p == id);
    let mapped = match provider {
        "anthropic" => "anthropic",
        // Same Claake provider, two Prime providers: ChatGPT login vs API key.
        "openai" if has("openai-codex") => "openai-codex",
        "openai" => "openai",
        "openrouter" => "openrouter",
        "mistral" => "mistral",
        "google" => {
            return Err("RLM chat cannot use the Google login: Prime has no Gemini Code Assist provider".into())
        }
        other => return Err(format!("RLM chat does not support provider '{other}' yet")),
    };
    if !has(mapped) {
        return Err(format!("Sign in to {provider} in Claake Code settings to use it in the RLM chat"));
    }
    Ok(mapped)
}

/// Resolution order: explicit override, then `prime-agent` next to the app executable
/// (where the bundler places sidecars). No download and no PATH lookup: the binary must be pinned.
fn sidecar_binary() -> std::result::Result<std::path::PathBuf, String> {
    if let Some(path) = std::env::var_os("CLAAKECODE_PRIME_BIN") {
        return Ok(path.into());
    }
    let name = if cfg!(windows) { "prime-agent.exe" } else { "prime-agent" };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|path| path.is_file())
        .ok_or_else(|| {
            "Prime sidecar is not installed: this build does not bundle prime-agent (set CLAAKECODE_PRIME_BIN to a pinned binary)".to_string()
        })
}

/// Directory of the bundled sidecars, only when it actually ships `uv`.
fn sidecar_dir() -> Option<std::path::PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let uv = if cfg!(windows) { "uv.exe" } else { "uv" };
    dir.join(uv).is_file().then_some(dir)
}

/// Refreshes credentials into Prime's auth.json before every turn, then makes sure a daemon is
/// running. A daemon is restarted when the set of signed-in providers changed, because Prime
/// only re-reads auth.json for credentials it already knows; sessions reopen via `sessionPath`.
async fn ensure_sidecar(
    runtime: &mut RlmRuntime,
    data_root: &std::path::Path,
) -> std::result::Result<(std::path::PathBuf, Vec<(String, prime::PrimeCredential)>), String> {
    let credentials = collect_credentials().await;
    if credentials.is_empty() {
        return Err("RLM chat needs a signed-in provider: connect Anthropic, OpenAI, OpenRouter or Mistral in Settings".into());
    }
    let prime_dir = data_root.join("prime");
    std::fs::create_dir_all(&prime_dir).map_err(|err| err.to_string())?;
    let prime_dir = std::fs::canonicalize(&prime_dir).map_err(|err| err.to_string())?;
    prime::write_auth_file(&prime_dir.join("agent"), &credentials).map_err(error_to_string)?;
    let providers = provider_set(&credentials);
    if let Some(sidecar) = &runtime.sidecar {
        let alive = prime::daemon_alive(&sidecar.socket).await;
        if alive && runtime.providers == providers {
            return Ok((sidecar.socket.clone(), credentials));
        }
        if let Some(sidecar) = runtime.sidecar.take() {
            let _ = sidecar.stop().await;
        }
        runtime.sessions.clear();
    }
    let sidecar = Sidecar::start(&SidecarConfig {
        binary: sidecar_binary()?,
        data_dir: prime_dir,
        // The bundled `uv` sits next to prime-agent; Prime resolves it through PATH.
        uv_dir: sidecar_dir(),
        credentials: Vec::new(),
    })
    .await
    .map_err(error_to_string)?;
    let socket = sidecar.socket.clone();
    runtime.sidecar = Some(sidecar);
    runtime.providers = providers;
    Ok((socket, credentials))
}

#[tauri::command]
pub(super) async fn create_rlm_conversation(
    state: State<'_, DesktopState>,
    input: WorkspaceInput,
) -> std::result::Result<WorkspaceBootstrap, String> {
    let root = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    // Worktree first: if isolation is impossible, no RLM conversation is created at all.
    let tag = format!(
        "{:x}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
    );
    let worktree = crate::git::create_rlm_worktree(&root, &tag).map_err(error_to_string)?;
    let conversation = state
        .store
        .create_rlm_conversation(&root.display().to_string(), &state.default_model, &state.system_prompt)
        .map_err(error_to_string)?;
    state
        .store
        .set_rlm_worktree(&conversation.id, &worktree.display().to_string())
        .map_err(error_to_string)?;
    state
        .store
        .bootstrap_workspace(&root, &state.default_model, &state.system_prompt)
        .map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn send_rlm_message(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: RlmMessageInput,
) -> std::result::Result<(), String> {
    let text = input.text.trim().to_string();
    if text.is_empty() {
        return Err("message cannot be empty".into());
    }
    let root = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let workspace_id = root.display().to_string();
    // Never run RLM against a conversation of another harness.
    match state.store.conversation_harness(&input.conversation_id).map_err(error_to_string)?.as_deref() {
        Some("rlm") => {}
        _ => return Err("conversation is not an RLM conversation".into()),
    }
    // Prime only ever runs inside the conversation's worktree, never the user's checkout.
    let binding = state
        .store
        .rlm_binding(&input.conversation_id)
        .map_err(error_to_string)?
        .ok_or("RLM conversation has no isolated worktree; create a new RLM chat")?;
    let worktree = std::path::PathBuf::from(&binding.worktree_path);
    if !worktree.is_dir() {
        return Err(format!("RLM worktree is missing: {}", binding.worktree_path));
    }
    let (socket, session_id, credentials) = {
        let mut runtime = state.rlm.lock().await;
        let (socket, credentials) =
            ensure_sidecar(&mut runtime, state.store.path().parent().ok_or("no data dir")?).await?;
        let session_id = match runtime.sessions.get(&input.conversation_id) {
            Some(id) => id.clone(),
            None => {
                // A stored session file means this conversation already ran: reopen its transcript.
                let (id, file) = prime::create_session_with(
                    &socket,
                    &worktree,
                    "claakecode-rlm",
                    None,
                    binding.session_path.as_deref(),
                )
                .await
                .map_err(error_to_string)?;
                if let Some(file) = file {
                    state.store.set_rlm_session(&input.conversation_id, Some(&file)).map_err(error_to_string)?;
                }
                runtime.sessions.insert(input.conversation_id.clone(), id.clone());
                id
            }
        };
        (socket, session_id, credentials)
    };
    if let Some(model) = &input.model {
        let provider = prime_provider(&model.provider, &credentials)?;
        prime::set_model(&socket, &session_id, provider, &model.name)
            .await
            .map_err(|_| format!("Prime refused model {}/{} (provider not signed in or unknown to Prime)", model.provider, model.name))?;
    }
    // Same single-turn rule as the classic chat: one running turn per conversation, visible
    // in the active-turns list. Stop goes through Prime's abort, not this cancel handle.
    {
        let mut active_turns = state.active_turns.lock().await;
        if active_turns.contains_key(&input.conversation_id) {
            return Err("a turn is already running for this conversation".into());
        }
        active_turns.insert(input.conversation_id.clone(), TurnCancel::empty());
    }
    register_active_turn(&app, &state, &workspace_id, &input.conversation_id).await;
    let conversation_id = input.conversation_id.clone();
    // Persisted like a classic turn so reopening the conversation shows it. Prime keeps the
    // authoritative transcript; this is the readable copy shown by the chat.
    let _ = state.store.append_conversation_message(
        &workspace_id,
        &conversation_id,
        &claakecode_core::ChatMessage::user_text(text.clone()),
    );
    let mut reply = String::new();
    let result = prime::run_prompt(&socket, &session_id, &text, Duration::from_secs(30 * 60), |event| {
        if let AgentEvent::TextChunk { delta } = &event {
            reply.push_str(delta);
        }
        let _ = emit_agent_event(&app, &workspace_id, &conversation_id, &event);
    })
    .await;
    if !reply.is_empty() {
        let _ = state.store.append_conversation_message(
            &workspace_id,
            &conversation_id,
            &claakecode_core::ChatMessage::assistant_text(reply),
        );
    }
    state.active_turns.lock().await.remove(&conversation_id);
    state
        .active_turn_details
        .lock()
        .map(|mut active| active.remove(&conversation_id))
        .ok();
    emit_active_turns_changed(&app, &state.active_turn_details).await;
    if let Err(err) = &result {
        let _ = emit_agent_event(
            &app,
            &workspace_id,
            &conversation_id,
            &AgentEvent::Error { message: error_to_string(anyhow::anyhow!("{err:#}")) },
        );
    }
    result.map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn stop_rlm_turn(
    state: State<'_, DesktopState>,
    input: ConversationInput,
) -> std::result::Result<(), String> {
    let (socket, session_id) = {
        let runtime = state.rlm.lock().await;
        let socket = runtime.sidecar.as_ref().map(|s| s.socket.clone());
        (socket, runtime.sessions.get(&input.conversation_id).cloned())
    };
    let (Some(socket), Some(session_id)) = (socket, session_id) else { return Ok(()) };
    prime::abort_session(&socket, &session_id).await.map_err(error_to_string)
}

/// Exposes the isolation of an RLM conversation so the UI can show where Prime works.
#[tauri::command]
pub(super) async fn get_rlm_binding(
    state: State<'_, DesktopState>,
    input: ConversationInput,
) -> std::result::Result<Option<claakecode_app::store::RlmBinding>, String> {
    state.store.rlm_binding(&input.conversation_id).map_err(error_to_string)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PythonRuntimeStatus {
    env: prime::PythonEnvStatus,
    /// Prime daemon running (kernels live inside it).
    running: bool,
    /// RLM conversations with a live Prime session (each owns a persistent kernel).
    active_sessions: usize,
    connected_providers: Vec<String>,
}

/// Settings view of the persistent Python used by the RLM chat (one engine: Prime's kernel).
#[tauri::command]
pub(super) async fn get_python_runtime_status(
    state: State<'_, DesktopState>,
) -> std::result::Result<PythonRuntimeStatus, String> {
    let data_root = state.store.path().parent().ok_or("no data dir")?.to_path_buf();
    let env = tokio::task::spawn_blocking(move || prime::inspect_python_env(&data_root.join("prime").join("kernel-venv")))
        .await
        .map_err(|err| err.to_string())?;
    let runtime = state.rlm.lock().await;
    let running = match &runtime.sidecar {
        Some(sidecar) => prime::daemon_alive(&sidecar.socket).await,
        None => false,
    };
    Ok(PythonRuntimeStatus {
        env,
        running,
        active_sessions: if running { runtime.sessions.len() } else { 0 },
        connected_providers: runtime.providers.clone(),
    })
}

/// Stops Prime (and every kernel). Sessions reopen from their saved file on the next message.
#[tauri::command]
pub(super) async fn restart_python_runtime(state: State<'_, DesktopState>) -> std::result::Result<(), String> {
    shutdown_rlm(&state.rlm).await;
    Ok(())
}

/// Stops the sidecar; called on app exit so no daemon outlives Claake Code.
pub(super) async fn shutdown_rlm(rlm: &SharedRlm) {
    let mut runtime = rlm.lock().await;
    runtime.sessions.clear();
    runtime.providers.clear();
    if let Some(sidecar) = runtime.sidecar.take() {
        let _ = sidecar.stop().await;
    }
}
