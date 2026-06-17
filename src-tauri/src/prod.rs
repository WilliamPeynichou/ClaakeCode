use crate::*;

const PROD_STATUS_TIMEOUT_SECS: u64 = 30;
const PROD_INSTALL_TIMEOUT_SECS: u64 = 10;
const PROD_LOGIN_TIMEOUT_SECS: u64 = 180;
const PROD_LOGOUT_TIMEOUT_SECS: u64 = 60;
const PROD_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;
const PROD_MESSAGE_LIMIT_CHARS: usize = 500;

#[derive(Clone, Copy)]
struct ProdProviderSpec {
    id: &'static str,
    name: &'static str,
    cli_name: &'static str,
    cli_candidates: &'static [&'static str],
    install_url: &'static str,
    token_env_var: Option<&'static str>,
    login_args: &'static [&'static str],
    auth_check_args: &'static [&'static str],
    logout_args: &'static [&'static str],
    auth_check_label: &'static str,
    actions: &'static [ProdQuickActionSpec],
}

#[derive(Clone, Copy)]
struct ProdQuickActionSpec {
    id: &'static str,
    label: &'static str,
    command: &'static str,
    requires_confirmation: bool,
}

#[derive(Debug)]
struct HiddenPtyOutput {
    exit_code: Option<u32>,
    timed_out: bool,
    output: String,
}

#[tauri::command]
pub(super) async fn prod_providers() -> std::result::Result<Vec<ProdProviderDescriptor>, String> {
    Ok(prod_provider_specs()
        .iter()
        .map(|provider| provider.descriptor())
        .collect())
}

#[tauri::command]
pub(super) async fn prod_get_settings(
    state: State<'_, DesktopState>,
) -> std::result::Result<ProdSettingsOutput, String> {
    prod_settings_from_store(&state)
}

#[tauri::command]
pub(super) async fn prod_save_token(
    state: State<'_, DesktopState>,
    input: ProdTokenInput,
) -> std::result::Result<ProdProviderRuntimeStatus, String> {
    state
        .store
        .save_prod_provider_token(&input.provider_id, &input.token)
        .map_err(error_to_string)?;
    prod_runtime_status_from_secret(&state, &input.provider_id)
}

#[tauri::command]
pub(super) async fn prod_clear_token(
    state: State<'_, DesktopState>,
    input: ProdProviderIdInput,
) -> std::result::Result<ProdProviderRuntimeStatus, String> {
    state
        .store
        .clear_prod_provider_token(&input.provider_id)
        .map_err(error_to_string)?;
    prod_runtime_status_from_secret(&state, &input.provider_id)
}

#[tauri::command]
pub(super) async fn prod_refresh_status(
    state: State<'_, DesktopState>,
    input: ProdRefreshStatusInput,
) -> std::result::Result<ProdSettingsOutput, String> {
    let statuses = refresh_prod_provider_status_impl(&state, input).await?;
    persist_prod_statuses(&state, &statuses)?;
    Ok(ProdSettingsOutput {
        providers: statuses
            .into_iter()
            .map(|status| prod_runtime_status_from_status(&state, status))
            .collect::<std::result::Result<Vec<_>, String>>()?,
    })
}

#[tauri::command]
pub(super) async fn prod_connect(
    state: State<'_, DesktopState>,
    input: ProdConnectInput,
) -> std::result::Result<ProdProviderRuntimeStatus, String> {
    if let Some(token) = input
        .token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        state
            .store
            .save_prod_provider_token(&input.provider_id, token)
            .map_err(error_to_string)?;
    }
    let result = connect_prod_provider_impl(
        &state,
        ProdProviderWorkspaceInput {
            provider_id: input.provider_id,
            workspace_path: None,
        },
    )
    .await?;
    persist_prod_statuses(&state, std::slice::from_ref(&result.status))?;
    prod_runtime_status_from_status(&state, result.status)
}

#[tauri::command]
pub(super) async fn prod_disconnect(
    state: State<'_, DesktopState>,
    input: ProdProviderIdInput,
) -> std::result::Result<ProdProviderRuntimeStatus, String> {
    let result = disconnect_prod_provider_impl(
        &state,
        ProdProviderWorkspaceInput {
            provider_id: input.provider_id,
            workspace_path: None,
        },
    )
    .await?;
    persist_prod_statuses(&state, std::slice::from_ref(&result.status))?;
    prod_runtime_status_from_status(&state, result.status)
}

async fn refresh_prod_provider_status_impl(
    state: &DesktopState,
    input: ProdRefreshStatusInput,
) -> std::result::Result<Vec<ProdProviderStatus>, String> {
    if let Some(provider_id) = input
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let provider = prod_provider_by_id(provider_id)?;
        let status = provider_status(provider, state, None).await?;
        return Ok(vec![status]);
    }

    // Keep the implementation intentionally simple and bounded: providers are
    // checked sequentially via short-lived hidden PTYs, so no visible terminal
    // session or event is created and no secret can be streamed to the UI.
    let mut statuses = Vec::with_capacity(prod_provider_specs().len());
    for provider in prod_provider_specs() {
        statuses.push(provider_status(provider, state, None).await?);
    }
    Ok(statuses)
}

async fn connect_prod_provider_impl(
    state: &DesktopState,
    input: ProdProviderWorkspaceInput,
) -> std::result::Result<ProdProviderOperationResult, String> {
    let provider = prod_provider_by_id(&input.provider_id)?;
    let cwd = normalized_optional_workspace(input.workspace_path.as_deref())?;
    let Some(cli) = detect_installed_cli(provider).await? else {
        let status = not_installed_status(provider);
        return Ok(ProdProviderOperationResult {
            ok: false,
            message: format!(
                "{} CLI is not installed. Install it from {}.",
                provider.name, provider.install_url
            ),
            status,
        });
    };

    let token = load_prod_token_for_hidden_terminal(provider, state).await?;
    if let Some(token) = token.as_deref() {
        let env = token_env(provider, token);
        let status = provider_status_with_cli(provider, state, &cli, env).await?;
        return Ok(ProdProviderOperationResult {
            ok: status.connected,
            message: if status.connected {
                format!("{} is connected via saved token.", provider.name)
            } else {
                format!(
                    "{} token was saved but authentication could not be verified.",
                    provider.name
                )
            },
            status,
        });
    }

    let login = run_hidden_provider_command(
        &cli,
        provider.login_args,
        cwd.as_deref(),
        None,
        Duration::from_secs(PROD_LOGIN_TIMEOUT_SECS),
        &[],
    )
    .await?;

    let status = provider_status_with_cli(provider, state, &cli, None).await?;
    let ok = status.connected;
    let message = if ok {
        format!("{} is connected.", provider.name)
    } else if login.timed_out {
        format!(
            "{} login timed out before authentication could be verified.",
            provider.name
        )
    } else if login.exit_code == Some(0) {
        format!(
            "{} login finished, but authentication could not be verified.",
            provider.name
        )
    } else {
        format!(
            "{} login failed; check the provider CLI or try token login.",
            provider.name
        )
    };

    Ok(ProdProviderOperationResult {
        ok,
        message,
        status,
    })
}

async fn disconnect_prod_provider_impl(
    state: &DesktopState,
    input: ProdProviderWorkspaceInput,
) -> std::result::Result<ProdProviderOperationResult, String> {
    let provider = prod_provider_by_id(&input.provider_id)?;
    let cwd = normalized_optional_workspace(input.workspace_path.as_deref())?;
    let Some(cli) = detect_installed_cli(provider).await? else {
        let status = not_installed_status(provider);
        return Ok(ProdProviderOperationResult {
            ok: false,
            message: format!("{} CLI is not installed.", provider.name),
            status,
        });
    };

    let _logout = run_hidden_provider_command(
        &cli,
        provider.logout_args,
        cwd.as_deref(),
        None,
        Duration::from_secs(PROD_LOGOUT_TIMEOUT_SECS),
        &[],
    )
    .await?;

    let status = provider_status_with_cli(provider, state, &cli, None).await?;
    Ok(ProdProviderOperationResult {
        ok: !status.connected,
        message: if status.connected {
            format!(
                "{} logout command finished, but the CLI still reports an authenticated session.",
                provider.name
            )
        } else {
            format!("{} is disconnected.", provider.name)
        },
        status,
    })
}

async fn provider_status(
    provider: &ProdProviderSpec,
    state: &DesktopState,
    cwd: Option<&Path>,
) -> std::result::Result<ProdProviderStatus, String> {
    let Some(cli) = detect_installed_cli(provider).await? else {
        return Ok(not_installed_status(provider));
    };
    let token = load_prod_token_for_hidden_terminal(provider, state).await?;
    let env = token
        .as_deref()
        .and_then(|token| token_env(provider, token));
    provider_status_with_cli(provider, state, &cli, env)
        .await
        .map(|status| {
            if let Some(cwd) = cwd {
                let _ = cwd;
            }
            status
        })
}

async fn provider_status_with_cli(
    provider: &ProdProviderSpec,
    _state: &DesktopState,
    cli: &str,
    token_env: Option<(&str, &str)>,
) -> std::result::Result<ProdProviderStatus, String> {
    let secrets = token_env
        .map(|(_, value)| vec![value.to_string()])
        .unwrap_or_default();
    let output = run_hidden_provider_command(
        cli,
        provider.auth_check_args,
        None,
        token_env,
        Duration::from_secs(PROD_STATUS_TIMEOUT_SECS),
        &secrets,
    )
    .await?;

    Ok(status_from_auth_output(provider, cli, output))
}

async fn detect_installed_cli(
    provider: &ProdProviderSpec,
) -> std::result::Result<Option<String>, String> {
    for candidate in provider.cli_candidates {
        match run_hidden_provider_command(
            candidate,
            &["--version"],
            None,
            None,
            Duration::from_secs(PROD_INSTALL_TIMEOUT_SECS),
            &[],
        )
        .await
        {
            Ok(_) => return Ok(Some((*candidate).to_string())),
            Err(_) => continue,
        }
    }
    Ok(None)
}

fn status_from_auth_output(
    provider: &ProdProviderSpec,
    cli: &str,
    output: HiddenPtyOutput,
) -> ProdProviderStatus {
    let message = sanitized_status_message(&output.output);
    let (auth_state, identity) = if output.timed_out {
        (ProdProviderAuthState::Unknown, None)
    } else if looks_like_logged_out(&output.output) {
        (ProdProviderAuthState::Disconnected, None)
    } else if output.exit_code == Some(0) {
        (
            ProdProviderAuthState::Connected,
            extract_provider_identity(provider.id, &output.output),
        )
    } else {
        (ProdProviderAuthState::Error, None)
    };

    ProdProviderStatus {
        provider_id: provider.id.to_string(),
        installed: true,
        cli: provider.cli_name.to_string(),
        cli_path: Some(cli.to_string()),
        auth_state,
        connected: auth_state == ProdProviderAuthState::Connected,
        identity,
        message,
        checked_at_ms: now_ms(),
    }
}

fn not_installed_status(provider: &ProdProviderSpec) -> ProdProviderStatus {
    ProdProviderStatus {
        provider_id: provider.id.to_string(),
        installed: false,
        cli: provider.cli_name.to_string(),
        cli_path: None,
        auth_state: ProdProviderAuthState::Unknown,
        connected: false,
        identity: None,
        message: Some(format!("{} CLI not installed", provider.cli_name)),
        checked_at_ms: now_ms(),
    }
}

async fn run_hidden_provider_command(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    token_env: Option<(&str, &str)>,
    timeout: Duration,
    secrets: &[String],
) -> std::result::Result<HiddenPtyOutput, String> {
    let program = program.to_string();
    let args = args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    let cwd = cwd.map(Path::to_path_buf);
    let token_env = token_env.map(|(key, value)| (key.to_string(), value.to_string()));
    let secrets = secrets.to_vec();
    tokio::task::spawn_blocking(move || {
        run_hidden_provider_command_blocking(
            &program,
            &args,
            cwd.as_deref(),
            token_env.as_ref(),
            timeout,
            &secrets,
        )
    })
    .await
    .map_err(error_to_string)?
}

fn run_hidden_provider_command_blocking(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    token_env: Option<&(String, String)>,
    timeout: Duration,
    secrets: &[String],
) -> std::result::Result<HiddenPtyOutput, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(error_to_string)?;

    let mut command = CommandBuilder::new(program);
    for arg in args {
        command.arg(arg);
    }
    if let Some(cwd) = cwd {
        command.cwd(cwd.as_os_str());
    }
    command.env("TERM", "xterm-256color");
    command.env("NO_COLOR", "1");
    if let Some((key, value)) = token_env {
        command.env(key, value);
    }

    let mut child = pair.slave.spawn_command(command).map_err(error_to_string)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(error_to_string)?;
    let killer = Arc::new(StdMutex::new(child.clone_killer()));
    let captured = Arc::new(StdMutex::new(Vec::<u8>::new()));
    let reader_output = captured.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut output) = reader_output.lock() {
                        let remaining = PROD_OUTPUT_LIMIT_BYTES.saturating_sub(output.len());
                        if remaining > 0 {
                            output.extend_from_slice(&buffer[..n.min(remaining)]);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (status_tx, status_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = status_tx.send(status);
    });

    let mut timed_out = false;
    let exit_code = match status_rx.recv_timeout(timeout) {
        Ok(Ok(status)) => Some(status.exit_code()),
        Ok(Err(_)) => None,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            timed_out = true;
            if let Ok(mut killer) = killer.lock() {
                let _ = killer.kill();
            }
            match status_rx.recv_timeout(Duration::from_secs(3)) {
                Ok(Ok(status)) => Some(status.exit_code()),
                _ => None,
            }
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => None,
    };

    let _ = reader_thread.join();
    let output = captured
        .lock()
        .map(|bytes| bytes.clone())
        .unwrap_or_default();
    let output = String::from_utf8_lossy(&output).to_string();
    Ok(HiddenPtyOutput {
        exit_code,
        timed_out,
        output: redact_secrets(&strip_ansi(&output), secrets),
    })
}

async fn load_prod_token_for_hidden_terminal(
    provider: &ProdProviderSpec,
    state: &DesktopState,
) -> std::result::Result<Option<String>, String> {
    state
        .store
        .load_prod_provider_token(provider.id)
        .map_err(|err| state.store.redact_prod_message(error_to_string(err)))
}

fn token_env<'a>(provider: &'a ProdProviderSpec, token: &'a str) -> Option<(&'a str, &'a str)> {
    provider
        .token_env_var
        .filter(|_| !token.trim().is_empty())
        .map(|env| (env, token.trim()))
}

fn normalized_optional_workspace(
    value: Option<&str>,
) -> std::result::Result<Option<PathBuf>, String> {
    value
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(normalize_workspace_root)
        .transpose()
        .map_err(error_to_string)
}

fn prod_provider_by_id(id: &str) -> std::result::Result<&'static ProdProviderSpec, String> {
    let normalized = id.trim();
    prod_provider_specs()
        .iter()
        .find(|provider| provider.id == normalized)
        .ok_or_else(|| format!("unknown prod provider `{normalized}`"))
}

impl ProdProviderSpec {
    fn descriptor(self) -> ProdProviderDescriptor {
        ProdProviderDescriptor {
            id: self.id.to_string(),
            name: self.name.to_string(),
            cli_name: self.cli_name.to_string(),
            cli_candidates: self
                .cli_candidates
                .iter()
                .map(|candidate| (*candidate).to_string())
                .collect(),
            install_url: self.install_url.to_string(),
            token_env_var: self.token_env_var.map(str::to_string),
            login_label: format!("{} {}", self.cli_candidates[0], self.login_args.join(" ")),
            auth_check_label: self.auth_check_label.to_string(),
            actions: self
                .actions
                .iter()
                .map(|action| ProdQuickActionDescriptor {
                    id: action.id.to_string(),
                    label: action.label.to_string(),
                    command: action.command.to_string(),
                    requires_confirmation: action.requires_confirmation,
                })
                .collect(),
        }
    }
}

fn looks_like_logged_out(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("not logged in")
        || lower.contains("not authenticated")
        || lower.contains("not authorized")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("login")
        || lower.contains("log in")
        || lower.contains("please authenticate")
        || lower.contains("authentication required")
}

fn sanitized_status_message(output: &str) -> Option<String> {
    let clean = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join(" ");
    let clean = clip_chars(&clean, PROD_MESSAGE_LIMIT_CHARS);
    (!clean.is_empty()).then_some(clean)
}

fn extract_provider_identity(provider_id: &str, output: &str) -> Option<String> {
    let clean = strip_ansi(output);
    let mut lines = clean.lines().map(str::trim).filter(|line| !line.is_empty());
    match provider_id {
        "vercel" | "fly" | "heroku" => lines
            .find(|line| !line.to_ascii_lowercase().contains("warning"))
            .map(|line| clip_chars(line, 120)),
        "railway" => lines
            .find(|line| line.to_ascii_lowercase().contains("logged in"))
            .or_else(|| clean.lines().map(str::trim).find(|line| line.contains('@')))
            .map(|line| clip_chars(line, 120)),
        "netlify" => lines
            .find(|line| {
                let lower = line.to_ascii_lowercase();
                lower.contains("email") || lower.contains("account") || line.contains('@')
            })
            .map(|line| clip_chars(line, 120)),
        "cloudflare" => lines
            .find(|line| {
                let lower = line.to_ascii_lowercase();
                lower.contains("logged in") || lower.contains("account") || line.contains('@')
            })
            .map(|line| clip_chars(line, 120)),
        _ => None,
    }
}

fn strip_ansi(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if matches!(chars.peek(), Some('[')) {
                let _ = chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
                continue;
            }
        }
        if ch != '\r' {
            output.push(ch);
        }
    }
    output
}

fn redact_secrets(value: &str, secrets: &[String]) -> String {
    redact_prod_secret_text(value, secrets)
}

fn prod_settings_from_store(
    state: &DesktopState,
) -> std::result::Result<ProdSettingsOutput, String> {
    let settings = state.store.load_prod_settings().map_err(error_to_string)?;
    Ok(ProdSettingsOutput {
        providers: prod_provider_specs()
            .iter()
            .map(|provider| {
                let saved = settings
                    .providers
                    .iter()
                    .find(|saved| saved.provider_id == provider.id);
                prod_runtime_status_from_saved_provider(provider.id, saved)
            })
            .collect(),
    })
}

fn prod_runtime_status_from_saved_provider(
    provider_id: &str,
    saved: Option<&ProdProviderSettings>,
) -> ProdProviderRuntimeStatus {
    let token_configured = saved.map(|provider| provider.has_token).unwrap_or(false);
    let token_preview = saved.and_then(|provider| provider.token_preview.clone());
    if let Some(status) = saved.and_then(|provider| provider.last_status.as_ref()) {
        return ProdProviderRuntimeStatus {
            provider_id: provider_id.to_string(),
            cli_status: match status.cli_installed {
                Some(false) => "missing",
                Some(true) => "installed",
                None => match status.state {
                    ProdProviderConnectionState::Unknown => "unknown",
                    _ => "installed",
                },
            }
            .into(),
            auth_status: match status.state {
                ProdProviderConnectionState::Unknown => "unknown",
                ProdProviderConnectionState::Connected => "connected",
                ProdProviderConnectionState::Disconnected => "disconnected",
                ProdProviderConnectionState::Error => "error",
            }
            .into(),
            identity: status.identity.clone(),
            error: status.message.clone(),
            token_configured,
            token_preview,
            last_checked_ms: status.timestamp_ms,
        };
    }
    ProdProviderRuntimeStatus {
        provider_id: provider_id.to_string(),
        cli_status: "unknown".into(),
        auth_status: "unknown".into(),
        identity: None,
        error: None,
        token_configured,
        token_preview,
        last_checked_ms: None,
    }
}

fn prod_runtime_status_from_secret(
    state: &DesktopState,
    provider_id: &str,
) -> std::result::Result<ProdProviderRuntimeStatus, String> {
    let provider = prod_provider_by_id(provider_id)?;
    let secret = state
        .store
        .list_prod_provider_secret_states()
        .map_err(error_to_string)?
        .into_iter()
        .find(|secret| secret.provider_id == provider.id);
    Ok(ProdProviderRuntimeStatus {
        provider_id: provider.id.to_string(),
        cli_status: "unknown".into(),
        auth_status: "unknown".into(),
        identity: None,
        error: None,
        token_configured: secret
            .as_ref()
            .map(|secret| secret.has_token)
            .unwrap_or(false),
        token_preview: secret.and_then(|secret| secret.token_preview),
        last_checked_ms: None,
    })
}

fn prod_runtime_status_from_status(
    state: &DesktopState,
    status: ProdProviderStatus,
) -> std::result::Result<ProdProviderRuntimeStatus, String> {
    let secret = state
        .store
        .list_prod_provider_secret_states()
        .map_err(error_to_string)?
        .into_iter()
        .find(|secret| secret.provider_id == status.provider_id);
    Ok(ProdProviderRuntimeStatus {
        provider_id: status.provider_id,
        cli_status: if status.installed {
            "installed"
        } else {
            "missing"
        }
        .into(),
        auth_status: match status.auth_state {
            ProdProviderAuthState::Unknown => "unknown",
            ProdProviderAuthState::Connected => "connected",
            ProdProviderAuthState::Disconnected => "disconnected",
            ProdProviderAuthState::Error => "error",
        }
        .into(),
        identity: status
            .identity
            .map(|identity| state.store.redact_prod_message(identity))
            .filter(|identity| !identity.trim().is_empty()),
        error: status
            .message
            .map(|message| state.store.redact_prod_message(message))
            .filter(|message| !message.trim().is_empty()),
        token_configured: secret
            .as_ref()
            .map(|secret| secret.has_token)
            .unwrap_or(false),
        token_preview: secret.and_then(|secret| secret.token_preview),
        last_checked_ms: Some(status.checked_at_ms),
    })
}

fn persist_prod_statuses(
    state: &DesktopState,
    statuses: &[ProdProviderStatus],
) -> std::result::Result<(), String> {
    if statuses.is_empty() {
        return Ok(());
    }
    let mut settings = state.store.load_prod_settings().map_err(error_to_string)?;
    for status in statuses {
        if let Some(provider) = settings
            .providers
            .iter_mut()
            .find(|provider| provider.provider_id == status.provider_id)
        {
            provider.last_status = Some(prod_cached_status_from_runtime(status, state));
        }
    }
    state
        .store
        .save_prod_settings(&settings)
        .map_err(error_to_string)?;
    Ok(())
}

fn prod_cached_status_from_runtime(
    status: &ProdProviderStatus,
    state: &DesktopState,
) -> ProdProviderCachedStatus {
    ProdProviderCachedStatus {
        state: match status.auth_state {
            ProdProviderAuthState::Unknown => ProdProviderConnectionState::Unknown,
            ProdProviderAuthState::Connected => ProdProviderConnectionState::Connected,
            ProdProviderAuthState::Disconnected => ProdProviderConnectionState::Disconnected,
            ProdProviderAuthState::Error => ProdProviderConnectionState::Error,
        },
        cli_installed: Some(status.installed),
        identity: status
            .identity
            .as_ref()
            .map(|identity| state.store.redact_prod_message(identity))
            .filter(|identity| !identity.trim().is_empty()),
        message: status
            .message
            .as_ref()
            .map(|message| state.store.redact_prod_message(message))
            .filter(|message| !message.trim().is_empty()),
        timestamp_ms: Some(status.checked_at_ms),
    }
}

fn clip_chars(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut clipped = trimmed
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    clipped.push('…');
    clipped
}

fn prod_provider_specs() -> &'static [ProdProviderSpec] {
    &PROD_PROVIDERS
}

static VERCEL_ACTIONS: &[ProdQuickActionSpec] = &[
    ProdQuickActionSpec {
        id: "deploy",
        label: "Deploy",
        command: "vercel",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "deployProd",
        label: "Deploy prod",
        command: "vercel --prod",
        requires_confirmation: true,
    },
    ProdQuickActionSpec {
        id: "env",
        label: "Env",
        command: "vercel env",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "logs",
        label: "Logs",
        command: "vercel logs",
        requires_confirmation: false,
    },
];

static RAILWAY_ACTIONS: &[ProdQuickActionSpec] = &[
    ProdQuickActionSpec {
        id: "init",
        label: "Init",
        command: "railway init",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "link",
        label: "Link",
        command: "railway link",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "up",
        label: "Up",
        command: "railway up",
        requires_confirmation: true,
    },
    ProdQuickActionSpec {
        id: "logs",
        label: "Logs",
        command: "railway logs",
        requires_confirmation: false,
    },
];

static NETLIFY_ACTIONS: &[ProdQuickActionSpec] = &[
    ProdQuickActionSpec {
        id: "init",
        label: "Init",
        command: "netlify init",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "deploy",
        label: "Deploy",
        command: "netlify deploy",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "deployProd",
        label: "Deploy prod",
        command: "netlify deploy --prod",
        requires_confirmation: true,
    },
    ProdQuickActionSpec {
        id: "dev",
        label: "Dev",
        command: "netlify dev",
        requires_confirmation: false,
    },
];

static RENDER_ACTIONS: &[ProdQuickActionSpec] = &[
    ProdQuickActionSpec {
        id: "services",
        label: "Services",
        command: "render services",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "deploy",
        label: "Create deploy",
        command: "render deploys create",
        requires_confirmation: true,
    },
    ProdQuickActionSpec {
        id: "logs",
        label: "Logs",
        command: "render logs",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "ssh",
        label: "SSH",
        command: "render ssh",
        requires_confirmation: false,
    },
];

static FLY_ACTIONS: &[ProdQuickActionSpec] = &[
    ProdQuickActionSpec {
        id: "launch",
        label: "Launch",
        command: "fly launch",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "deploy",
        label: "Deploy",
        command: "fly deploy",
        requires_confirmation: true,
    },
    ProdQuickActionSpec {
        id: "logs",
        label: "Logs",
        command: "fly logs",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "ssh",
        label: "SSH",
        command: "fly ssh console",
        requires_confirmation: false,
    },
];

static HEROKU_ACTIONS: &[ProdQuickActionSpec] = &[
    ProdQuickActionSpec {
        id: "create",
        label: "Create",
        command: "heroku create",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "deploy",
        label: "Deploy",
        command: "git push heroku main",
        requires_confirmation: true,
    },
    ProdQuickActionSpec {
        id: "logs",
        label: "Logs",
        command: "heroku logs --tail",
        requires_confirmation: false,
    },
];

static CLOUDFLARE_ACTIONS: &[ProdQuickActionSpec] = &[
    ProdQuickActionSpec {
        id: "dev",
        label: "Dev",
        command: "wrangler dev",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "deploy",
        label: "Deploy",
        command: "wrangler deploy",
        requires_confirmation: true,
    },
    ProdQuickActionSpec {
        id: "pagesDeploy",
        label: "Pages deploy",
        command: "wrangler pages deploy",
        requires_confirmation: true,
    },
];

static SUPABASE_ACTIONS: &[ProdQuickActionSpec] = &[
    ProdQuickActionSpec {
        id: "init",
        label: "Init",
        command: "supabase init",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "start",
        label: "Start",
        command: "supabase start",
        requires_confirmation: false,
    },
    ProdQuickActionSpec {
        id: "dbPush",
        label: "DB push",
        command: "supabase db push",
        requires_confirmation: true,
    },
    ProdQuickActionSpec {
        id: "functionsDeploy",
        label: "Deploy functions",
        command: "supabase functions deploy",
        requires_confirmation: true,
    },
];

static PROD_PROVIDERS: [ProdProviderSpec; 8] = [
    ProdProviderSpec {
        id: "vercel",
        name: "Vercel",
        cli_name: "vercel",
        cli_candidates: &["vercel"],
        install_url: "https://vercel.com/docs/cli",
        token_env_var: Some("VERCEL_TOKEN"),
        login_args: &["login"],
        auth_check_args: &["whoami"],
        logout_args: &["logout"],
        auth_check_label: "vercel whoami",
        actions: VERCEL_ACTIONS,
    },
    ProdProviderSpec {
        id: "railway",
        name: "Railway",
        cli_name: "railway",
        cli_candidates: &["railway"],
        install_url: "https://docs.railway.app/guides/cli",
        token_env_var: Some("RAILWAY_TOKEN"),
        login_args: &["login"],
        auth_check_args: &["whoami"],
        logout_args: &["logout"],
        auth_check_label: "railway whoami",
        actions: RAILWAY_ACTIONS,
    },
    ProdProviderSpec {
        id: "netlify",
        name: "Netlify",
        cli_name: "netlify",
        cli_candidates: &["netlify"],
        install_url: "https://docs.netlify.com/cli/get-started/",
        token_env_var: Some("NETLIFY_AUTH_TOKEN"),
        login_args: &["login"],
        auth_check_args: &["status"],
        logout_args: &["logout"],
        auth_check_label: "netlify status",
        actions: NETLIFY_ACTIONS,
    },
    ProdProviderSpec {
        id: "render",
        name: "Render",
        cli_name: "render",
        cli_candidates: &["render"],
        install_url: "https://render.com/docs/cli",
        token_env_var: Some("RENDER_API_KEY"),
        login_args: &["login"],
        auth_check_args: &["services"],
        logout_args: &["logout"],
        auth_check_label: "render services",
        actions: RENDER_ACTIONS,
    },
    ProdProviderSpec {
        id: "fly",
        name: "Fly.io",
        cli_name: "fly",
        cli_candidates: &["fly", "flyctl"],
        install_url: "https://fly.io/docs/flyctl/install/",
        token_env_var: Some("FLY_API_TOKEN"),
        login_args: &["auth", "login"],
        auth_check_args: &["auth", "whoami"],
        logout_args: &["auth", "logout"],
        auth_check_label: "fly auth whoami",
        actions: FLY_ACTIONS,
    },
    ProdProviderSpec {
        id: "heroku",
        name: "Heroku",
        cli_name: "heroku",
        cli_candidates: &["heroku"],
        install_url: "https://devcenter.heroku.com/articles/heroku-cli",
        token_env_var: Some("HEROKU_API_KEY"),
        login_args: &["login"],
        auth_check_args: &["auth:whoami"],
        logout_args: &["auth:logout"],
        auth_check_label: "heroku auth:whoami",
        actions: HEROKU_ACTIONS,
    },
    ProdProviderSpec {
        id: "cloudflare",
        name: "Cloudflare",
        cli_name: "wrangler",
        cli_candidates: &["wrangler"],
        install_url: "https://developers.cloudflare.com/workers/wrangler/install-and-update/",
        token_env_var: Some("CLOUDFLARE_API_TOKEN"),
        login_args: &["login"],
        auth_check_args: &["whoami"],
        logout_args: &["logout"],
        auth_check_label: "wrangler whoami",
        actions: CLOUDFLARE_ACTIONS,
    },
    ProdProviderSpec {
        id: "supabase",
        name: "Supabase",
        cli_name: "supabase",
        cli_candidates: &["supabase"],
        install_url: "https://supabase.com/docs/guides/cli/getting-started",
        token_env_var: Some("SUPABASE_ACCESS_TOKEN"),
        login_args: &["login"],
        auth_check_args: &["projects", "list"],
        logout_args: &["logout"],
        auth_check_label: "supabase projects list",
        actions: SUPABASE_ACTIONS,
    },
];
