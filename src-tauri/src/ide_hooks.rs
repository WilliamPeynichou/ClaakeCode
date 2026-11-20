//! User-configured IDE hooks: local commands run by the IDE itself, never by a model.
//!
//! Hooks live in the app data directory, keyed by workspace. A repository can
//! neither add nor enable one. Output stays on this machine.
use crate::ide_process::{self, Finish};
use crate::*;
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    hash::{Hash, Hasher},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Notify;

const SETTINGS_FILE: &str = "ide-hooks.json";
const MAX_HOOKS: usize = 20;
const MAX_RUNS: usize = 100;
const MAX_TIMEOUT_SECS: u64 = 600;
const CHANGE_DEBOUNCE: Duration = Duration::from_millis(600);
const MUTE_AFTER_RUN: Duration = Duration::from_millis(1500);
const RUN_EVENT: &str = "ide-hooks-run-changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum HookEvent {
    BeforeCommit,
    FilesChanged,
    TurnFinished,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Hook {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) event: HookEvent,
    pub(super) program: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    pub(super) enabled: bool,
    pub(super) timeout_secs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RunStatus {
    Running,
    Succeeded,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HookRun {
    workspace_path: String,
    id: String,
    hook_name: String,
    event: HookEvent,
    status: RunStatus,
    duration_ms: u64,
    exit_code: Option<i32>,
    error: Option<String>,
    output: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookRunProgress<'a> {
    workspace_path: &'a str,
    id: &'a str,
    hook_name: &'a str,
    event: HookEvent,
    status: RunStatus,
    duration_ms: u64,
    exit_code: Option<i32>,
    error: Option<&'a str>,
}

#[derive(Default)]
pub(super) struct HookRuntime {
    runs: std::sync::Mutex<Vec<HookRun>>,
    cancels: std::sync::Mutex<HashMap<String, Arc<Notify>>>,
    pending: std::sync::Mutex<HashMap<String, HashSet<String>>>,
    muted_until: std::sync::Mutex<HashMap<String, Instant>>,
    settings_lock: tokio::sync::Mutex<()>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HooksInput {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SaveHooksInput {
    workspace_path: String,
    hooks: Vec<Hook>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CancelHookInput {
    workspace_path: String,
    run_id: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join(SETTINGS_FILE))
}

fn load_all(app: &AppHandle) -> Result<HashMap<String, Vec<Hook>>> {
    let path = settings_path(app)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str(&text).with_context(|| format!("invalid {}", path.display()))?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(err) => Err(err.into()),
    }
}

fn enabled_hooks(app: &AppHandle, workspace: &str, event: HookEvent) -> Vec<Hook> {
    match load_all(app) {
        Ok(mut all) => all
            .remove(workspace)
            .unwrap_or_default()
            .into_iter()
            .filter(|hook| hook.enabled && hook.event == event)
            .collect(),
        Err(err) => {
            tracing::warn!(%err, "unable to read IDE hooks");
            Vec::new()
        }
    }
}

fn validate(hooks: &[Hook]) -> Result<()> {
    anyhow::ensure!(hooks.len() <= MAX_HOOKS, "at most {MAX_HOOKS} hooks per workspace");
    let mut ids = HashSet::new();
    for hook in hooks {
        anyhow::ensure!(!hook.id.trim().is_empty() && ids.insert(hook.id.as_str()), "hook ids must be unique");
        anyhow::ensure!(!hook.name.trim().is_empty(), "hook name cannot be empty");
        anyhow::ensure!(!hook.program.trim().is_empty(), "hook '{}' has no command", hook.name);
        anyhow::ensure!(
            (1..=MAX_TIMEOUT_SECS).contains(&hook.timeout_secs),
            "hook '{}' timeout must be 1-{MAX_TIMEOUT_SECS} seconds",
            hook.name
        );
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn ide_hooks_list(app: AppHandle, input: HooksInput) -> std::result::Result<Vec<Hook>, String> {
    let workspace = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let mut all = load_all(&app).map_err(error_to_string)?;
    Ok(all.remove(&workspace.display().to_string()).unwrap_or_default())
}

#[tauri::command]
pub(super) async fn ide_hooks_save(
    app: AppHandle,
    state: State<'_, HookRuntime>,
    input: SaveHooksInput,
) -> std::result::Result<Vec<Hook>, String> {
    let workspace = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    validate(&input.hooks).map_err(error_to_string)?;
    let _guard = state.settings_lock.lock().await;
    let mut all = load_all(&app).map_err(error_to_string)?;
    all.insert(workspace.display().to_string(), input.hooks.clone());
    let path = settings_path(&app).map_err(error_to_string)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(error_to_string)?;
    }
    let text = serde_json::to_string_pretty(&all).map_err(error_to_string)?;
    fs::write(&path, text).map_err(error_to_string)?;
    Ok(input.hooks)
}

#[tauri::command]
pub(super) async fn ide_hooks_runs(
    state: State<'_, HookRuntime>,
    input: HooksInput,
) -> std::result::Result<Vec<HookRun>, String> {
    let workspace = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let key = workspace.display().to_string();
    let runs = state.runs.lock().map_err(|err| err.to_string())?;
    Ok(runs.iter().filter(|run| run.workspace_path == key).cloned().collect())
}

#[tauri::command]
pub(super) async fn ide_hooks_cancel(
    state: State<'_, HookRuntime>,
    input: CancelHookInput,
) -> std::result::Result<bool, String> {
    let _ = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let cancel = state.cancels.lock().map_err(|err| err.to_string())?.get(&input.run_id).cloned();
    Ok(cancel.map(|notify| notify.notify_one()).is_some())
}

fn next_run_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("{millis}-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

fn update_run(app: &AppHandle, run: &HookRun, is_new: bool) {
    let runtime = app.state::<HookRuntime>();
    if let Ok(mut runs) = runtime.runs.lock() {
        match runs.iter_mut().find(|existing| existing.id == run.id) {
            Some(existing) => *existing = run.clone(),
            None if is_new => {
                runs.push(run.clone());
                let overflow = runs.len().saturating_sub(MAX_RUNS);
                runs.drain(..overflow);
            }
            None => {}
        }
    }
    let _ = app.emit(
        RUN_EVENT,
        HookRunProgress {
            workspace_path: &run.workspace_path,
            id: &run.id,
            hook_name: &run.hook_name,
            event: run.event,
            status: run.status,
            duration_ms: run.duration_ms,
            exit_code: run.exit_code,
            error: run.error.as_deref(),
        },
    );
}

async fn run_hook(app: &AppHandle, workspace: &str, cwd: &Path, hook: &Hook, envs: &[(String, String)]) -> HookRun {
    let mut run = HookRun {
        workspace_path: workspace.to_string(),
        id: next_run_id(),
        hook_name: hook.name.clone(),
        event: hook.event,
        status: RunStatus::Running,
        duration_ms: 0,
        exit_code: None,
        error: None,
        output: String::new(),
    };
    update_run(app, &run, true);
    let cancel = Arc::new(Notify::new());
    if let Ok(mut cancels) = app.state::<HookRuntime>().cancels.lock() {
        cancels.insert(run.id.clone(), cancel.clone());
    }
    let started = Instant::now();
    let mut all_envs = vec![("CLAAKE_HOOK_EVENT".to_string(), format!("{:?}", hook.event))];
    all_envs.extend_from_slice(envs);
    let result = ide_process::run(&hook.program, &hook.args, cwd, &all_envs, Duration::from_secs(hook.timeout_secs), &cancel).await;
    run.duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(done) => {
            run.exit_code = done.exit_code;
            run.output = format!("{}{}", done.stdout, done.stderr);
            run.status = match done.finish {
                Finish::Exited if done.exit_code == Some(0) => RunStatus::Succeeded,
                Finish::Exited => RunStatus::Failed,
                Finish::TimedOut => RunStatus::TimedOut,
                Finish::Cancelled => RunStatus::Cancelled,
            };
        }
        Err(err) => {
            run.status = RunStatus::Failed;
            run.error = Some(format!("unable to start '{}': {err}", hook.program));
        }
    }
    if let Ok(mut cancels) = app.state::<HookRuntime>().cancels.lock() {
        cancels.remove(&run.id);
    }
    update_run(app, &run, false);
    run
}

fn selection_fingerprint(repo: &Path, paths: &[String]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for path in paths {
        path.hash(&mut hasher);
        fs::read(repo.join(path)).ok().hash(&mut hasher);
    }
    hasher.finish()
}

/// Runs enabled before-commit hooks in order; the first failure blocks the commit.
pub(super) async fn before_commit(
    app: &AppHandle,
    workspace_root: &Path,
    repo_root: &Path,
    paths: Vec<String>,
    head: Option<String>,
) -> Result<()> {
    let workspace = workspace_root.display().to_string();
    let hooks = enabled_hooks(app, &workspace, HookEvent::BeforeCommit);
    if hooks.is_empty() {
        return Ok(());
    }
    let before = selection_fingerprint(repo_root, &paths);
    let envs = vec![("CLAAKE_COMMIT_FILES".to_string(), paths.join("\n"))];
    for hook in &hooks {
        let run = run_hook(app, &workspace, repo_root, hook, &envs).await;
        if run.status != RunStatus::Succeeded {
            let detail = run.error.clone().unwrap_or_else(|| format!("{:?}", run.status));
            anyhow::bail!("Commit blocked: hook '{}' did not succeed ({detail}).", hook.name);
        }
    }
    let head_after = git::current_head(repo_root);
    if head_after != head || selection_fingerprint(repo_root, &paths) != before {
        anyhow::bail!("Commit blocked: hooks changed the selected files or HEAD. Review the diff, then commit again.");
    }
    Ok(())
}

async fn run_background(app: AppHandle, workspace: String, worktree: PathBuf, event: HookEvent, envs: Vec<(String, String)>) {
    let hooks = enabled_hooks(&app, &workspace, event);
    for hook in &hooks {
        run_hook(&app, &workspace, &worktree, hook, &envs).await;
    }
}

/// Collects changed paths; one batch runs after a quiet period. Writes made by
/// the hooks themselves are ignored while they run and shortly after.
pub(super) fn files_changed(app: &AppHandle, workspace_root: &Path, worktree_root: &Path, paths: Vec<String>) {
    let runtime = app.state::<HookRuntime>();
    let key = worktree_root.display().to_string();
    if let Ok(muted) = runtime.muted_until.lock() {
        if muted.get(&key).is_some_and(|until| *until > Instant::now()) {
            return;
        }
    }
    let first = match runtime.pending.lock() {
        Ok(mut pending) => {
            let first = !pending.contains_key(&key);
            pending.entry(key.clone()).or_default().extend(paths);
            first
        }
        Err(_) => return,
    };
    if !first {
        return;
    }
    let app = app.clone();
    let workspace = workspace_root.display().to_string();
    let worktree = worktree_root.to_path_buf();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CHANGE_DEBOUNCE).await;
        let runtime = app.state::<HookRuntime>();
        let batch = runtime.pending.lock().ok().and_then(|mut pending| pending.remove(&key)).unwrap_or_default();
        if batch.is_empty() || enabled_hooks(&app, &workspace, HookEvent::FilesChanged).is_empty() {
            return;
        }
        if let Ok(mut muted) = runtime.muted_until.lock() {
            muted.insert(key.clone(), Instant::now() + Duration::from_secs(3600));
        }
        let mut changed: Vec<String> = batch.into_iter().filter(|path| !path.is_empty()).collect();
        changed.sort();
        let envs = vec![("CLAAKE_CHANGED_FILES".to_string(), changed.join("\n"))];
        run_background(app.clone(), workspace, worktree, HookEvent::FilesChanged, envs).await;
        if let Ok(mut muted) = runtime.muted_until.lock() {
            muted.insert(key, Instant::now() + MUTE_AFTER_RUN);
        };
    });
}

pub(super) fn turn_finished(app: &AppHandle, workspace_root: &Path, worktree_root: &Path, turn_id: String) {
    let app = app.clone();
    let workspace = workspace_root.display().to_string();
    let worktree = worktree_root.to_path_buf();
    tauri::async_runtime::spawn(async move {
        let envs = vec![("CLAAKE_TURN_ID".to_string(), turn_id)];
        run_background(app, workspace, worktree, HookEvent::TurnFinished, envs).await;
    });
}
