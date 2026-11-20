//! Automatic diagnostics: after files change on disk, run the project's own checker
//! (`tsc --noEmit`, `cargo check`) and publish the problems to the IDE. No model involved.
//!
//! Running a checker executes project code (build scripts, proc macros, the local
//! compiler), so it only starts after the user enables it for the workspace.
use crate::ide_process::{self, Finish};
use crate::*;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Notify;

const UPDATE_EVENT: &str = "workspace-diagnostics-updated";
const DEBOUNCE: Duration = Duration::from_millis(900);
const CHECK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_DIAGNOSTICS: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProjectStatus {
    Running,
    Ok,
    Problems,
    ToolMissing,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectState {
    root: String,
    tool: &'static str,
    status: ProjectStatus,
    message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Problem {
    path: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
    severity: &'static str,
    code: Option<String>,
    message: String,
    source: &'static str,
}

#[derive(Default)]
struct WorkspaceDiagnostics {
    enabled: bool,
    scheduler_running: bool,
    dirty: HashSet<PathBuf>,
    projects: HashMap<PathBuf, ProjectState>,
    problems: HashMap<PathBuf, Vec<Problem>>,
    cancel: Option<Arc<Notify>>,
}

#[derive(Default)]
pub(super) struct DiagnosticsState {
    workspaces: std::sync::Mutex<HashMap<PathBuf, WorkspaceDiagnostics>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiagnosticsSnapshot {
    workspace_path: String,
    registered: bool,
    enabled: bool,
    running: bool,
    projects: Vec<ProjectState>,
    problems: Vec<Problem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiagnosticsInput {
    workspace_path: String,
    enabled: Option<bool>,
}

fn snapshot_of(root: &Path, entry: Option<&WorkspaceDiagnostics>) -> DiagnosticsSnapshot {
    let Some(entry) = entry else {
        return DiagnosticsSnapshot {
            workspace_path: root.display().to_string(),
            registered: false,
            enabled: false,
            running: false,
            projects: Vec::new(),
            problems: Vec::new(),
        };
    };
    let mut projects: Vec<_> = entry.projects.values().cloned().collect();
    projects.sort_by(|a, b| a.root.cmp(&b.root));
    let mut problems: Vec<_> = entry.problems.values().flatten().cloned().collect();
    problems.sort_by(|a, b| (&a.path, a.line, a.column).cmp(&(&b.path, b.line, b.column)));
    problems.truncate(MAX_DIAGNOSTICS);
    DiagnosticsSnapshot {
        workspace_path: root.display().to_string(),
        registered: true,
        enabled: entry.enabled,
        running: projects.iter().any(|p| p.status == ProjectStatus::Running) || !entry.dirty.is_empty(),
        projects,
        problems,
    }
}

fn publish(app: &AppHandle, root: &Path) {
    let state = app.state::<DiagnosticsState>();
    let snapshot = match state.workspaces.lock() {
        Ok(map) => snapshot_of(root, map.get(root)),
        Err(_) => return,
    };
    let _ = app.emit(UPDATE_EVENT, snapshot);
}

pub(super) fn open_workspace(app: &AppHandle, root: &Path) {
    if let Ok(mut map) = app.state::<DiagnosticsState>().workspaces.lock() {
        map.entry(root.to_path_buf()).or_default();
    }
}

/// Drops results and revokes the permission when the last watcher of a workspace closes.
pub(super) fn close_workspace(app: &AppHandle, root: &Path) {
    if let Ok(mut map) = app.state::<DiagnosticsState>().workspaces.lock() {
        if let Some(entry) = map.remove(root) {
            if let Some(cancel) = entry.cancel {
                cancel.notify_waiters();
            }
        }
    }
}

#[tauri::command]
pub(super) async fn diagnostics_snapshot(
    state: State<'_, DiagnosticsState>,
    input: DiagnosticsInput,
) -> std::result::Result<DiagnosticsSnapshot, String> {
    let root = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let map = state.workspaces.lock().map_err(|err| err.to_string())?;
    Ok(snapshot_of(&root, map.get(&root)))
}

#[tauri::command]
pub(super) async fn diagnostics_set_enabled(
    app: AppHandle,
    state: State<'_, DiagnosticsState>,
    input: DiagnosticsInput,
) -> std::result::Result<DiagnosticsSnapshot, String> {
    let root = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let enabled = input.enabled.unwrap_or(false);
    {
        let mut map = state.workspaces.lock().map_err(|err| err.to_string())?;
        let entry = map.get_mut(&root).ok_or("workspace is not being watched")?;
        entry.enabled = enabled;
        if !enabled {
            if let Some(cancel) = &entry.cancel {
                cancel.notify_waiters();
            }
            entry.projects.clear();
            entry.problems.clear();
            entry.dirty.clear();
        }
    }
    if enabled {
        mark_all_projects_dirty(&app, &root);
    }
    publish(&app, &root);
    let map = state.workspaces.lock().map_err(|err| err.to_string())?;
    Ok(snapshot_of(&root, map.get(&root)))
}

#[tauri::command]
pub(super) async fn diagnostics_rerun(
    app: AppHandle,
    state: State<'_, DiagnosticsState>,
    input: DiagnosticsInput,
) -> std::result::Result<DiagnosticsSnapshot, String> {
    let root = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    mark_all_projects_dirty(&app, &root);
    let map = state.workspaces.lock().map_err(|err| err.to_string())?;
    Ok(snapshot_of(&root, map.get(&root)))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tool {
    TypeScript,
    Cargo,
}

fn tool_for_dir(dir: &Path) -> Option<Tool> {
    if dir.join("tsconfig.json").is_file() {
        Some(Tool::TypeScript)
    } else if dir.join("Cargo.toml").is_file() {
        Some(Tool::Cargo)
    } else {
        None
    }
}

fn relevant_extension(relative: &str) -> bool {
    matches!(
        Path::new(relative).extension().and_then(|e| e.to_str()),
        Some("ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "json" | "rs" | "toml")
    )
}

/// Nearest ancestor (up to the workspace root) holding a tsconfig.json or Cargo.toml.
fn project_for(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut dir = root.join(relative);
    dir.pop();
    while dir.starts_with(root) {
        if tool_for_dir(&dir).is_some() {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn mark_all_projects_dirty(app: &AppHandle, root: &Path) {
    let mut projects = vec![root.to_path_buf()];
    if let Ok(entries) = fs::read_dir(root) {
        projects.extend(entries.flatten().map(|e| e.path()).filter(|p| p.is_dir() && !should_ignore_workspace_event_path(root, p)));
    }
    for project in projects.into_iter().filter(|p| tool_for_dir(p).is_some()) {
        schedule(app, root, project);
    }
}

pub(super) fn file_changed(app: &AppHandle, root: &Path, relative: &str) {
    if relative.is_empty() || !relevant_extension(relative) {
        return;
    }
    if let Some(project) = project_for(root, relative) {
        schedule(app, root, project);
    }
}

fn schedule(app: &AppHandle, root: &Path, project: PathBuf) {
    let start = {
        let diagnostics_state = app.state::<DiagnosticsState>();
        let Ok(mut map) = diagnostics_state.workspaces.lock() else { return };
        let Some(entry) = map.get_mut(root) else { return };
        if !entry.enabled {
            return;
        }
        entry.dirty.insert(project);
        !std::mem::replace(&mut entry.scheduler_running, true)
    };
    if !start {
        return;
    }
    let app = app.clone();
    let root = root.to_path_buf();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DEBOUNCE).await;
        loop {
            let (project, cancel) = {
                let diagnostics_state = app.state::<DiagnosticsState>();
        let Ok(mut map) = diagnostics_state.workspaces.lock() else { return };
                let Some(entry) = map.get_mut(&root) else { return };
                let Some(project) = entry.dirty.iter().next().cloned() else {
                    entry.scheduler_running = false;
                    drop(map);
                    publish(&app, &root);
                    return;
                };
                entry.dirty.remove(&project);
                let cancel = Arc::new(Notify::new());
                entry.cancel = Some(cancel.clone());
                if let Some(tool) = tool_for_dir(&project) {
                    entry.projects.insert(
                        project.clone(),
                        ProjectState { root: relative_display(&root, &project), tool: tool_name(tool), status: ProjectStatus::Running, message: None },
                    );
                }
                (project, cancel)
            };
            publish(&app, &root);
            let (state, problems) = check_project(&root, &project, &cancel).await;
            let diagnostics_state = app.state::<DiagnosticsState>();
        let Ok(mut map) = diagnostics_state.workspaces.lock() else { return };
            let Some(entry) = map.get_mut(&root) else { return };
            if !entry.enabled {
                entry.scheduler_running = false;
                return;
            }
            // A newer change made this result stale; it is rechecked right after.
            if !entry.dirty.contains(&project) {
                entry.projects.insert(project.clone(), state);
                entry.problems.insert(project, problems);
            }
            drop(map);
            publish(&app, &root);
        }
    });
}

fn tool_name(tool: Tool) -> &'static str {
    match tool {
        Tool::TypeScript => "tsc",
        Tool::Cargo => "cargo check",
    }
}

fn relative_display(root: &Path, dir: &Path) -> String {
    match dir.strip_prefix(root) {
        Ok(rel) if rel.as_os_str().is_empty() => ".".to_string(),
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => dir.display().to_string(),
    }
}

async fn check_project(root: &Path, project: &Path, cancel: &Notify) -> (ProjectState, Vec<Problem>) {
    let tool = tool_for_dir(project).unwrap_or(Tool::Cargo);
    let mut state = ProjectState { root: relative_display(root, project), tool: tool_name(tool), status: ProjectStatus::Ok, message: None };
    let (program, args): (String, Vec<String>) = match tool {
        Tool::TypeScript => {
            let bin = if cfg!(windows) { "tsc.cmd" } else { "tsc" };
            let local = project.join("node_modules").join(".bin").join(bin);
            if !local.is_file() {
                state.status = ProjectStatus::ToolMissing;
                state.message = Some("TypeScript is not installed in this project (node_modules/.bin/tsc).".into());
                return (state, Vec::new());
            }
            (local.display().to_string(), vec!["--noEmit".into(), "--incremental".into(), "false".into(), "--pretty".into(), "false".into()])
        }
        Tool::Cargo => ("cargo".into(), vec!["check".into(), "--message-format=json".into(), "--quiet".into()]),
    };
    let result = match ide_process::run(&program, &args, project, &[], CHECK_TIMEOUT, cancel).await {
        Ok(result) => result,
        Err(err) => {
            state.status = if err.kind() == std::io::ErrorKind::NotFound { ProjectStatus::ToolMissing } else { ProjectStatus::Failed };
            state.message = Some(format!("unable to start {}: {err}", state.tool));
            return (state, Vec::new());
        }
    };
    match result.finish {
        Finish::TimedOut => {
            state.status = ProjectStatus::TimedOut;
            state.message = Some("The check timed out.".into());
            return (state, Vec::new());
        }
        Finish::Cancelled => {
            state.status = ProjectStatus::Cancelled;
            return (state, Vec::new());
        }
        Finish::Exited => {}
    }
    let problems = match tool {
        Tool::TypeScript => parse_tsc(root, project, &result.stdout),
        Tool::Cargo => parse_cargo(root, project, &result.stdout),
    };
    if problems.is_empty() && result.exit_code != Some(0) {
        state.status = ProjectStatus::Failed;
        let detail = format!("{}{}", result.stderr, result.stdout);
        state.message = Some(detail.lines().take(8).collect::<Vec<_>>().join("\n"));
    } else if problems.iter().any(|p| p.severity == "error") {
        state.status = ProjectStatus::Problems;
    } else if !problems.is_empty() {
        state.status = ProjectStatus::Problems;
    }
    (state, problems)
}

fn workspace_relative(root: &Path, project: &Path, file: &str) -> Option<String> {
    let full = project.join(file);
    let rel = full.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// `src/a.ts(12,5): error TS2322: message`
fn parse_tsc(root: &Path, project: &Path, output: &str) -> Vec<Problem> {
    let mut problems: Vec<Problem> = Vec::new();
    for line in output.lines() {
        let Some((location, rest)) = line.split_once("): ") else {
            if let (Some(last), true) = (problems.last_mut(), line.starts_with(' ')) {
                last.message.push('\n');
                last.message.push_str(line.trim());
            }
            continue;
        };
        let Some((file, position)) = location.rsplit_once('(') else { continue };
        let Some((line_no, column)) = position.split_once(',') else { continue };
        let (Ok(line_no), Ok(column)) = (line_no.parse::<u32>(), column.parse::<u32>()) else { continue };
        let Some((severity_and_code, message)) = rest.split_once(": ") else { continue };
        let (severity, code) = severity_and_code.split_once(' ').unwrap_or((severity_and_code, ""));
        let Some(path) = workspace_relative(root, project, file) else { continue };
        problems.push(Problem {
            path,
            line: line_no,
            column,
            end_line: line_no,
            end_column: column + 1,
            severity: if severity == "error" { "error" } else { "warning" },
            code: (!code.is_empty()).then(|| code.to_string()),
            message: message.to_string(),
            source: "tsc",
        });
    }
    problems
}

fn parse_cargo(root: &Path, project: &Path, output: &str) -> Vec<Problem> {
    let mut problems = Vec::new();
    for line in output.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        if value["reason"] != "compiler-message" {
            continue;
        }
        let message = &value["message"];
        let severity = match message["level"].as_str() {
            Some("error") => "error",
            Some("warning") => "warning",
            _ => continue,
        };
        let Some(spans) = message["spans"].as_array() else { continue };
        let Some(span) = spans.iter().find(|s| s["is_primary"] == true) else { continue };
        let Some(path) = span["file_name"].as_str().and_then(|f| workspace_relative(root, project, f)) else { continue };
        let number = |key: &str| span[key].as_u64().unwrap_or(1) as u32;
        problems.push(Problem {
            path,
            line: number("line_start"),
            column: number("column_start"),
            end_line: number("line_end"),
            end_column: number("column_end"),
            severity,
            code: message["code"]["code"].as_str().map(str::to_string),
            message: message["message"].as_str().unwrap_or_default().to_string(),
            source: "cargo",
        });
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tsc_output_becomes_workspace_relative_problems() {
        let root = Path::new("/w");
        let output = "src/a.ts(12,5): error TS2322: Type 'x' is not assignable.\n  detail line\n";
        let problems = parse_tsc(root, &root.join("app"), output);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].path, "app/src/a.ts");
        assert_eq!((problems[0].line, problems[0].column), (12, 5));
        assert_eq!(problems[0].code.as_deref(), Some("TS2322"));
        assert!(problems[0].message.contains("detail line"));
    }

    #[test]
    fn cargo_json_keeps_primary_spans_of_errors_and_warnings() {
        let root = Path::new("/w");
        let line = r#"{"reason":"compiler-message","message":{"level":"error","message":"boom","code":{"code":"E0425"},"spans":[{"is_primary":false,"file_name":"x.rs"},{"is_primary":true,"file_name":"src/lib.rs","line_start":3,"column_start":4,"line_end":3,"column_end":9}]}}"#;
        let problems = parse_cargo(root, root, &format!("{line}\n{{\"reason\":\"build-finished\"}}\n"));
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].path, "src/lib.rs");
        assert_eq!(problems[0].code.as_deref(), Some("E0425"));
    }

    #[test]
    fn project_is_the_nearest_ancestor_with_a_manifest() {
        let dir = std::env::temp_dir().join(format!("claake-diag-{}", std::process::id()));
        fs::create_dir_all(dir.join("pkg/src")).unwrap();
        fs::write(dir.join("pkg/tsconfig.json"), "{}").unwrap();
        assert_eq!(project_for(&dir, "pkg/src/a.ts"), Some(dir.join("pkg")));
        assert_eq!(project_for(&dir, "other/a.ts"), None);
        fs::remove_dir_all(dir).ok();
    }
}
