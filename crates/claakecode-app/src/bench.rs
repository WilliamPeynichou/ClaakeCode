//! Agent bench (lots D4a, D4b, D5): reproducible coding tasks judged by a `command` guard, run
//! with the real harness, and the promotion rule for candidate lessons.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use claakecode_core::{ChatMessage, ModelRef, Part, Provider};

use crate::agent::{run_turn, AgentMode, EngineCommand, TurnCancel, TurnContext};
use crate::run_engine::{judge, Guard, GuardVerdict};
use crate::{
    AppStore, BashTool, CreateImageTool, DatabaseTool, EditFileTool, GlobTool, GrepTool,
    McpToolRegistry, PythonTool, ReadTool, SkillTool, ToDoListTool, WebFetchTool, WebSearchTool,
    WriteFileTool,
};

fn default_rounds() -> usize {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchTask {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub guard: Guard,
    #[serde(default = "default_rounds")]
    pub max_tool_rounds: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutcome {
    pub task_id: String,
    pub passed: bool,
    pub tool_rounds: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// Tasks shipped with the repository (development builds only).
pub fn default_tasks_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bench/tasks")
}

/// One folder per task: `<dir>/<id>/task.json` and `<dir>/<id>/repo/`. Sorted by id.
pub fn load_tasks(dir: &Path) -> Result<Vec<BenchTask>> {
    let mut tasks = Vec::new();
    for entry in std::fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let folder = entry?.path();
        let file = folder.join("task.json");
        if !file.is_file() {
            continue;
        }
        let task: BenchTask = serde_json::from_slice(&std::fs::read(&file)?)
            .with_context(|| format!("invalid {}", file.display()))?;
        if !matches!(task.guard, Guard::Command { .. }) {
            bail!("task `{}`: the guard must be a `command`", task.id);
        }
        if folder.file_name().and_then(|name| name.to_str()) != Some(task.id.as_str()) {
            bail!("task `{}`: the folder name must be the task id", task.id);
        }
        if !folder.join("repo").is_dir() {
            bail!("task `{}`: missing repo folder", task.id);
        }
        tasks.push(task);
    }
    tasks.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(tasks)
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Throwaway copy of the task repo, with an initial git commit.
fn prepare_workspace(task_dir: &Path) -> Result<PathBuf> {
    let root = std::env::temp_dir().join(format!("claakecode-bench-{}", uuid::Uuid::new_v4()));
    copy_dir(&task_dir.join("repo"), &root)?;
    let root = std::fs::canonicalize(root)?;
    for args in [&["init", "-q"][..], &["add", "-A"], &["commit", "-q", "--allow-empty", "-m", "initial"]] {
        let status = std::process::Command::new("git")
            .args(["-c", "user.name=bench", "-c", "user.email=bench@local", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(&root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .context("git")?;
        if !status.success() {
            bail!("git {} failed in the bench workspace", args[0]);
        }
    }
    Ok(root)
}

/// Runs one task with the real agent loop (Act mode, default tool settings so no approval is
/// asked, no question tool, no sub-agents), then judges its guard on disk. `cmd` lets the
/// caller cancel; pass `None` in tests.
pub async fn run_task(
    provider: Arc<dyn Provider>,
    model: ModelRef,
    task: &BenchTask,
    task_dir: &Path,
    store: AppStore,
    base_system_prompt: &str,
    extra_system: Option<&str>,
    cmd: Option<(TurnCancel, mpsc::UnboundedReceiver<EngineCommand>)>,
) -> TaskOutcome {
    let started = Instant::now();
    let mut outcome = TaskOutcome {
        task_id: task.id.clone(),
        passed: false,
        tool_rounds: 0,
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: 0,
        error: None,
    };
    let root = match prepare_workspace(task_dir) {
        Ok(root) => root,
        Err(error) => {
            outcome.error = Some(error.to_string());
            return outcome;
        }
    };
    let system_prompt = match extra_system {
        Some(extra) => format!("{base_system_prompt}\n\n{extra}"),
        None => base_system_prompt.to_string(),
    };
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    // Nobody listens to bench events: drain them so the channel does not grow.
    let drain = tokio::spawn(async move { while event_rx.recv().await.is_some() {} });
    let (cancel, cmd_rx) = cmd.unwrap_or_else(|| {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        (TurnCancel::new(cmd_tx), cmd_rx)
    });
    let output = run_turn(TurnContext {
        provider,
        model,
        cache_key: None,
        cache_stable_message_count: 0,
        service_tier: None,
        auto_compact: true,
        mode: AgentMode::Act,
        stop_questions: false,
        system_prompt,
        history: vec![ChatMessage::user_text(task.prompt.clone())],
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
        database: Arc::new(DatabaseTool::new(store)),
        mcp: Arc::new(McpToolRegistry::new(Default::default())),
        subagents: None,
        teams: None,
        tool_settings: Default::default(),
        event_scope: None,
        max_tool_rounds: task.max_tool_rounds,
        event_tx,
        cancel,
        cmd_rx,
        run: None,
    })
    .await;
    drain.abort();
    for message in &output.history {
        if message.parts.iter().any(|part| matches!(part, Part::ToolCall { .. })) {
            outcome.tool_rounds += 1;
        }
        for part in &message.parts {
            let meta = match part {
                Part::Text { meta, .. } | Part::Thinking { meta, .. } | Part::ToolCall { meta, .. } => meta,
                _ => continue,
            };
            if let Some(usage) = meta.as_ref().and_then(|meta| meta.get("token_usage")) {
                outcome.input_tokens += usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                outcome.output_tokens += usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            }
        }
    }
    if output.interrupted {
        outcome.error = Some("interrupted".into());
    } else {
        outcome.passed = matches!(judge(&task.guard, &root, None).await, GuardVerdict::Pass);
    }
    let _ = std::fs::remove_dir_all(&root);
    outcome.duration_ms = started.elapsed().as_millis() as u64;
    outcome
}

fn rate(results: &[bool]) -> f64 {
    if results.is_empty() {
        return 0.0;
    }
    results.iter().filter(|passed| **passed).count() as f64 / results.len() as f64
}

/// Lot D5: `validated` only when the lesson does not lower the pass rate and something passes.
pub fn promotion_verdict(without: &[bool], with: &[bool]) -> (&'static str, f64, f64) {
    let (score_without, score_with) = (rate(without), rate(with));
    let status = if score_with >= score_without && score_with > 0.0 { "validated" } else { "rejected" };
    (status, score_without, score_with)
}

/// Tasks sharing a tag with the lesson; none in common falls back to the `bug` tasks.
pub fn tasks_for_tags<'a>(tasks: &'a [BenchTask], tags: &[String]) -> Vec<&'a BenchTask> {
    let matching = |wanted: &[String]| -> Vec<&'a BenchTask> {
        tasks.iter().filter(|task| task.tags.iter().any(|tag| wanted.contains(tag))).collect()
    };
    let selected = matching(tags);
    if selected.is_empty() { matching(&["bug".to_string()]) } else { selected }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::test_support::{text_response, tool_response, ScriptedProvider};
    use serde_json::json;

    #[tokio::test]
    async fn bench_tasks_load_and_start_red() {
        let dir = default_tasks_dir();
        let tasks = load_tasks(&dir).unwrap();
        assert!(tasks.len() >= 5, "{}", tasks.len());
        for task in &tasks {
            let root = prepare_workspace(&dir.join(&task.id)).unwrap();
            let verdict = judge(&task.guard, &root, None).await;
            let _ = std::fs::remove_dir_all(&root);
            assert!(matches!(verdict, GuardVerdict::Fail(_)), "task `{}` is green before any work", task.id);
        }
    }

    fn done_task() -> (PathBuf, BenchTask) {
        let dir = std::env::temp_dir().join(format!("claakecode-bench-task-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        std::fs::write(dir.join("repo/readme.txt"), "x").unwrap();
        let task = BenchTask {
            id: "done".into(),
            prompt: "Create done.txt".into(),
            tags: vec!["bug".into()],
            guard: Guard::Command { run: "test -f done.txt".into(), timeout_secs: 20 },
            max_tool_rounds: 5,
        };
        (dir, task)
    }

    #[tokio::test]
    async fn bench_run_task_passes_when_the_agent_does_the_work() {
        let (dir, task) = done_task();
        let model = ModelRef::new("scripted", "scripted");
        let working = ScriptedProvider::new(vec![
            tool_response("w1", "write_file", json!({ "path": "done.txt", "content": "ok" })),
            text_response("Done."),
        ]);
        let outcome = run_task(working, model.clone(), &task, &dir, AppStore::in_memory().unwrap(), "", None, None).await;
        assert!(outcome.passed, "{outcome:?}");
        assert_eq!((outcome.tool_rounds, outcome.error.clone()), (1, None));

        let idle = ScriptedProvider::new(vec![text_response("Nothing to do.")]);
        let outcome = run_task(idle, model, &task, &dir, AppStore::in_memory().unwrap(), "", Some("<x/>"), None).await;
        assert!(!outcome.passed);
        assert_eq!(outcome.error, None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn bench_promotion_verdict_rules() {
        let (t, f) = (true, false);
        assert_eq!(promotion_verdict(&[t, f, t], &[t, t, t]).0, "validated");
        assert_eq!(promotion_verdict(&[t, t, t], &[t, f, t]).0, "rejected");
        assert_eq!(promotion_verdict(&[f, f, f], &[f, f, f]).0, "rejected");
        let (_, without, with) = promotion_verdict(&[t, f, t], &[t, t, t]);
        assert!((without - 2.0 / 3.0).abs() < 1e-9 && with == 1.0);
    }

    #[test]
    fn bench_tasks_for_tags_falls_back_to_bug() {
        let tasks = load_tasks(&default_tasks_dir()).unwrap();
        let reading = tasks_for_tags(&tasks, &["reading".to_string()]);
        assert!(!reading.is_empty() && reading.iter().all(|task| task.tags.contains(&"reading".to_string())));
        let fallback = tasks_for_tags(&tasks, &["unknown".to_string()]);
        assert!(!fallback.is_empty() && fallback.iter().all(|task| task.tags.contains(&"bug".to_string())));
    }
}
