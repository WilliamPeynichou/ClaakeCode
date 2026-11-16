//! Reproducible coding tasks judged by a command guard, with explicit classic / native Prime
//! engines and the promotion rule for candidate SQL lessons. Fixtures are bundled in the app.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use claakecode_core::{ChatMessage, ModelRef, Part, Provider};

use crate::agent::{run_turn, AgentEvent, AgentMode, EngineCommand, TurnCancel, TurnContext};
use crate::prime::{self, Sidecar};

use crate::run_engine::{judge, Guard, GuardVerdict};
use crate::{
    AppStore, BashTool, CreateImageTool, DatabaseTool, EditFileTool, GlobTool, GrepTool,
    McpToolRegistry, PythonTool, ReadTool, SkillTool, ToDoListTool, WebFetchTool, WebSearchTool,
    WriteFileTool,
};

mod bundled;

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

/// Which engine was actually measured. Old saved reports used the classic engine.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BenchHarness {
    #[default]
    Classic,
    Rlm,
}

/// The compiled-in corpus, materialised for tools that operate on real files.
/// Its lifetime does not depend on the checkout or Tauri resource paths.
pub struct BundledTasks {
    root: TemporaryDirectory,
    pub tasks: Vec<BenchTask>,
}

impl BundledTasks {
    pub fn load() -> Result<Self> {
        let root = TemporaryDirectory::new("tasks")?;
        for (name, bytes) in bundled::FILES {
            let path = root.0.join(name);
            std::fs::create_dir_all(path.parent().context("task file parent")?)?;
            std::fs::write(path, bytes)?;
        }
        let tasks = load_tasks(&root.0)?;
        Ok(Self { root, tasks })
    }

    pub fn task_dir(&self, task: &BenchTask) -> PathBuf {
        self.root.0.join(&task.id)
    }
}

struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn new(label: &str) -> Result<Self> {
        let path =
            std::env::temp_dir().join(format!("claakecode-bench-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path)?;
        Ok(Self(std::fs::canonicalize(path)?))
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct TaskWorkspace {
    temporary: TemporaryDirectory,
    root: PathBuf,
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
fn prepare_workspace(task_dir: &Path) -> Result<TaskWorkspace> {
    let temporary = TemporaryDirectory::new("run")?;
    let root = temporary.0.join("repo");
    copy_dir(&task_dir.join("repo"), &root)?;
    for args in [
        &["init", "-q"][..],
        &["add", "-A"],
        &["commit", "-q", "--allow-empty", "-m", "initial"],
    ] {
        let status = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=bench",
                "-c",
                "user.email=bench@local",
                "-c",
                "commit.gpgsign=false",
            ])
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
    Ok(TaskWorkspace { temporary, root })
}

fn system_prompt(base: &str, lesson: Option<&str>) -> String {
    match lesson {
        Some(lesson) => format!("{base}\n\n{lesson}"),
        None => base.to_string(),
    }
}

fn empty_outcome(task: &BenchTask) -> TaskOutcome {
    TaskOutcome {
        task_id: task.id.clone(),
        passed: false,
        tool_rounds: 0,
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: 0,
        error: None,
    }
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
    let mut outcome = empty_outcome(task);
    let workspace = match prepare_workspace(task_dir) {
        Ok(root) => root,
        Err(error) => {
            outcome.error = Some(error.to_string());
            return outcome;
        }
    };
    let root = workspace.root.clone();
    let system_prompt = system_prompt(base_system_prompt, extra_system);
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
        if message
            .parts
            .iter()
            .any(|part| matches!(part, Part::ToolCall { .. }))
        {
            outcome.tool_rounds += 1;
        }
        for part in &message.parts {
            let meta = match part {
                Part::Text { meta, .. }
                | Part::Thinking { meta, .. }
                | Part::ToolCall { meta, .. } => meta,
                _ => continue,
            };
            if let Some(usage) = meta.as_ref().and_then(|meta| meta.get("token_usage")) {
                outcome.input_tokens += usage
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                outcome.output_tokens += usage
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
            }
        }
    }
    if output.interrupted {
        outcome.error = Some("interrupted".into());
    } else {
        outcome.passed = matches!(judge(&task.guard, &root, None).await, GuardVerdict::Pass);
    }
    outcome.duration_ms = started.elapsed().as_millis() as u64;
    outcome
}

/// Prime uses its normal native RLM prompt. This supplemental policy is identical in both
/// conditions; the tested SQL lesson is the only added text. Native memories stay isolated.
const RLM_BENCH_POLICY: &str = "Benchmark isolation: use only this disposable workspace. Do not read or write user or project data outside it. Harness memory is disposable and must not be treated as the user's memories. Do not create goals or recurring heartbeats. Complete the task, verify it, then stop.";

/// Fresh native Prime session and daemon per trial. `start_session` reuses the desktop's
/// credential/model setup while keeping all Prime state under the disposable data root.
pub async fn run_rlm_task<Start, Started>(
    task: &BenchTask,
    task_dir: &Path,
    base_system_prompt: &str,
    extra_system: Option<&str>,
    cancel: TurnCancel,
    mut cmd_rx: mpsc::UnboundedReceiver<EngineCommand>,
    start_session: Start,
) -> TaskOutcome
where
    Start: FnOnce(PathBuf, PathBuf, String) -> Started,
    Started: Future<Output = Result<(Sidecar, String)>>,
{
    let started = Instant::now();
    let mut outcome = empty_outcome(task);
    let result = async {
        let workspace = prepare_workspace(task_dir)?;
        let policy = system_prompt(base_system_prompt, Some(RLM_BENCH_POLICY));
        let prompt = system_prompt(&policy, extra_system);
        if cancel.is_cancelled() {
            bail!("interrupted");
        }
        let setup = start_session(
            workspace.temporary.0.join("prime-data"),
            workspace.root.clone(),
            prompt,
        );
        // Let startup finish so an owned Sidecar always guards any process it starts.
        // A cancellation queued during setup is handled before sending the task prompt.
        let (sidecar, session_id) = setup.await?;
        let trial = run_rlm_trial(
            &sidecar.socket,
            &session_id,
            task,
            &workspace.root,
            &cancel,
            &mut cmd_rx,
        )
        .await;
        // No daemon or memory from one arm can contaminate another arm or a real chat.
        let cleanup = sidecar.stop().await;
        let result = trial?;
        cleanup.context("stop isolated Prime benchmark")?;
        Ok::<_, anyhow::Error>(result)
    }
    .await;
    match result {
        Ok(result) => outcome = result,
        Err(error) => outcome.error = Some(format!("{error:#}")),
    }
    outcome.duration_ms = started.elapsed().as_millis() as u64;
    outcome
}

/// Shared execution path for real Prime and the socket mock. A guard is never judged as a
/// successful trial after an engine error, cancellation, missing terminal event or budget stop.
async fn run_rlm_trial(
    socket: &Path,
    session_id: &str,
    task: &BenchTask,
    root: &Path,
    cancel: &TurnCancel,
    cmd_rx: &mut mpsc::UnboundedReceiver<EngineCommand>,
) -> Result<TaskOutcome> {
    let mut outcome = empty_outcome(task);
    if cancel.is_cancelled() {
        let _ = prime::abort_session(socket, session_id).await;
        bail!("interrupted");
    }
    let (budget_tx, mut budget_rx) = mpsc::unbounded_channel();
    let mut finished = false;
    let mut engine_error = None;
    let mut tools = 0;
    let execution = {
        let run = prime::run_prompt(
            socket,
            session_id,
            &task.prompt,
            Duration::from_secs(180),
            |event| match event {
                AgentEvent::ToolStarted { .. } => {
                    tools += 1;
                    if tools > task.max_tool_rounds {
                        let _ = budget_tx.send(());
                    }
                }
                AgentEvent::TurnFinished { .. } => finished = true,
                AgentEvent::Error { message } => engine_error = Some(message),
                AgentEvent::Interrupted => engine_error = Some("interrupted".into()),
                AgentEvent::TokenUsage { usage, .. } => {
                    outcome.input_tokens += u64::from(usage.input_tokens);
                    outcome.output_tokens += u64::from(usage.output_tokens);
                }
                _ => {}
            },
        );
        tokio::pin!(run);
        tokio::select! {
            result = &mut run => result,
            _ = cmd_rx.recv() => Err(anyhow::anyhow!("interrupted")),
            _ = budget_rx.recv() => Err(anyhow::anyhow!("Prime task tool budget exceeded")),
        }
    };
    if execution.is_err() || cancel.is_cancelled() {
        let _ = prime::abort_session(socket, session_id).await;
    }
    execution?;
    if cancel.is_cancelled() {
        bail!("interrupted");
    }
    if let Some(error) = engine_error {
        bail!("{error}");
    }
    if !finished {
        bail!("Prime task ended without a successful terminal event");
    }
    if tools > task.max_tool_rounds {
        bail!("Prime task tool budget exceeded");
    }
    outcome.tool_rounds = tools as u64;
    outcome.passed = matches!(judge(&task.guard, root, None).await, GuardVerdict::Pass);
    Ok(outcome)
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
    let status = if score_with >= score_without && score_with > 0.0 {
        "validated"
    } else {
        "rejected"
    };
    (status, score_without, score_with)
}

/// Tasks sharing a tag with the lesson; none in common falls back to the `bug` tasks.
pub fn tasks_for_tags<'a>(tasks: &'a [BenchTask], tags: &[String]) -> Vec<&'a BenchTask> {
    let matching = |wanted: &[String]| -> Vec<&'a BenchTask> {
        tasks
            .iter()
            .filter(|task| task.tags.iter().any(|tag| wanted.contains(tag)))
            .collect()
    };
    let selected = matching(tags);
    if selected.is_empty() {
        matching(&["bug".to_string()])
    } else {
        selected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::test_support::{text_response, tool_response, ScriptedProvider};
    use serde_json::json;

    #[tokio::test]
    async fn bench_tasks_load_and_start_red() {
        let corpus = BundledTasks::load().unwrap();
        let dir = corpus.root.0.clone();
        let tasks = &corpus.tasks;
        assert_eq!(tasks.len(), 20);
        for tag in [
            "bug",
            "feature",
            "refactor",
            "reading",
            "tests",
            "multi-file",
        ] {
            let count = tasks
                .iter()
                .filter(|task| task.tags.iter().any(|t| t == tag))
                .count();
            assert!(count >= 3, "only {count} task(s) tagged `{tag}`");
        }
        for task in tasks {
            let workspace = prepare_workspace(&dir.join(&task.id)).unwrap();
            let root = &workspace.root;
            let verdict = judge(&task.guard, &root, None).await;
            let _ = std::fs::remove_dir_all(&root);
            assert!(
                matches!(verdict, GuardVerdict::Fail(_)),
                "task `{}` is green before any work",
                task.id
            );
        }
    }

    fn done_task() -> (PathBuf, BenchTask) {
        let dir =
            std::env::temp_dir().join(format!("claakecode-bench-task-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        std::fs::write(dir.join("repo/readme.txt"), "x").unwrap();
        let task = BenchTask {
            id: "done".into(),
            prompt: "Create done.txt".into(),
            tags: vec!["bug".into()],
            guard: Guard::Command {
                run: "test -f done.txt".into(),
                timeout_secs: 20,
            },
            max_tool_rounds: 5,
        };
        (dir, task)
    }

    #[tokio::test]
    async fn bench_run_task_passes_when_the_agent_does_the_work() {
        let (dir, task) = done_task();
        let model = ModelRef::new("scripted", "scripted");
        let working = ScriptedProvider::new(vec![
            tool_response(
                "w1",
                "write_file",
                json!({ "path": "done.txt", "content": "ok" }),
            ),
            text_response("Done."),
        ]);
        let outcome = run_task(
            working,
            model.clone(),
            &task,
            &dir,
            AppStore::in_memory().unwrap(),
            "",
            None,
            None,
        )
        .await;
        assert!(outcome.passed, "{outcome:?}");
        assert_eq!((outcome.tool_rounds, outcome.error.clone()), (1, None));

        let idle = ScriptedProvider::new(vec![text_response("Nothing to do.")]);
        let outcome = run_task(
            idle,
            model,
            &task,
            &dir,
            AppStore::in_memory().unwrap(),
            "",
            Some("<x/>"),
            None,
        )
        .await;
        assert!(!outcome.passed);
        assert_eq!(outcome.error, None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn bundled_corpus_cleans_up_and_prompt_changes_only_by_lesson() {
        let corpus = BundledTasks::load().unwrap();
        let root = corpus.root.0.clone();
        assert!(root.is_dir());
        drop(corpus);
        assert!(!root.exists());
        let base = system_prompt("base", Some(RLM_BENCH_POLICY));
        assert_eq!(system_prompt(&base, None), base);
        assert_eq!(
            system_prompt(&base, Some("lesson")),
            format!("{base}\n\nlesson")
        );
        assert_eq!(
            serde_json::to_string(&BenchHarness::Rlm).unwrap(),
            "\"rlm\""
        );
    }

    #[tokio::test]
    async fn rlm_bench_setup_is_fresh_isolated_and_cleans_failure() {
        let (dir, task) = done_task();
        let mut seen = Vec::new();
        for lesson in [None, Some("lesson under test")] {
            let (tx, rx) = mpsc::unbounded_channel();
            let outcome = run_rlm_task(
                &task,
                &dir,
                "base",
                lesson,
                TurnCancel::new(tx),
                rx,
                |data, workspace, prompt| {
                    assert_eq!(workspace.parent(), data.parent());
                    assert!(workspace.join("readme.txt").is_file());
                    assert!(!data.exists(), "must not reuse any harness memory");
                    seen.push((data, workspace, prompt));
                    async { bail!("scripted setup failure") }
                },
            )
            .await;
            assert!(outcome.error.unwrap().contains("scripted setup failure"));
            assert!(!outcome.passed);
        }
        assert_ne!(seen[0].0, seen[1].0);
        assert_eq!(seen[1].2, format!("{}\n\nlesson under test", seen[0].2));
        for (data, workspace, _) in seen {
            assert!(!data.parent().unwrap().exists());
            assert!(!workspace.exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rlm_bench_uses_prime_prompt_and_rejects_engine_failure() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;
        for (write_file, failed) in [(true, false), (false, false), (true, true)] {
            let (dir, task) = done_task();
            let workspace = prepare_workspace(&dir).unwrap();
            let root = workspace.root.clone();
            let socket =
                std::env::temp_dir().join(format!("cc-bench-{}.sock", uuid::Uuid::new_v4()));
            let listener = UnixListener::bind(&socket).unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let (reader, mut writer) = stream.into_split();
                let mut reader = BufReader::new(reader);
                for kind in ["attach", "prompt"] {
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                    assert_eq!(request["command"]["type"], kind);
                    assert_eq!(request["command"]["activeSessionId"], "trial");
                    if kind == "prompt" {
                        assert_eq!(request["command"]["message"], "Create done.txt");
                        if write_file {
                            std::fs::write(root.join("done.txt"), "ok").unwrap();
                        }
                    }
                    let data = if kind == "attach" {
                        json!({"snapshot":{"lastEventSequence":0,"state":{"isStreaming":false}}})
                    } else {
                        json!({})
                    };
                    let response =
                        json!({"type":"response","id":request["id"],"success":true,"data":data});
                    writer
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                }
                for (sequence, event) in [
                    json!({"type":"agent_start"}),
                    json!({"type":"tool_execution_start","toolCallId":"t","toolName":"bash"}),
                    json!({"type":"tool_execution_end","toolCallId":"t","toolName":"bash","isError":false}),
                    json!({"type":"agent_end","messages":[{"role":"assistant","content":[],
                        "stopReason":if failed { "error" } else { "stop" },"errorMessage":"scripted failure"}]}),
                ].into_iter().enumerate() {
                    let frame = json!({"type":"session_event","activeSessionId":"trial",
                        "meta":{"sequence":sequence+1},"event":event});
                    writer.write_all(format!("{frame}\n").as_bytes()).await.unwrap();
                }
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["command"]["type"], "wait_for_headless_completion");
                assert_eq!(request["command"]["waitForRlmQuiescence"], true);
                let response = json!({"type":"response","id":request["id"],"success":true,"data":{}});
                writer.write_all(format!("{response}\n").as_bytes()).await.unwrap();
            });
            let (tx, mut rx) = mpsc::unbounded_channel();
            let result = run_rlm_trial(
                &socket,
                "trial",
                &task,
                &workspace.root,
                &TurnCancel::new(tx),
                &mut rx,
            )
            .await;
            if failed {
                assert!(result.unwrap_err().to_string().contains("Prime run failed"));
            } else {
                let outcome = result.unwrap();
                assert_eq!(outcome.passed, write_file);
                assert_eq!(outcome.tool_rounds, 1);
            }
            server.await.unwrap();
            std::fs::remove_file(socket).unwrap();
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rlm_bench_cancellation_aborts_prime_separately() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;
        let (dir, task) = done_task();
        let workspace = prepare_workspace(&dir).unwrap();
        let socket = std::env::temp_dir().join(format!("cc-bench-{}.sock", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&socket).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cancel = TurnCancel::new(tx);
        let trigger = cancel.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let response = json!({"type":"response","id":request["id"],"success":true,
                "data":{"snapshot":{"lastEventSequence":0,"state":{"isStreaming":false}}}});
            writer
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["command"]["type"], "prompt");
            trigger.cancel_all();
            let (abort, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = abort.into_split();
            let mut line = String::new();
            BufReader::new(reader).read_line(&mut line).await.unwrap();
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["command"]["type"], "abort");
            let response = json!({"type":"response","id":request["id"],"success":true,"data":{}});
            writer
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        });
        let error = run_rlm_trial(&socket, "trial", &task, &workspace.root, &cancel, &mut rx)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "interrupted");
        server.await.unwrap();
        std::fs::remove_file(socket).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
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
        let corpus = BundledTasks::load().unwrap();
        let tasks = &corpus.tasks;
        let reading = tasks_for_tags(tasks, &["reading".to_string()]);
        assert!(
            !reading.is_empty()
                && reading
                    .iter()
                    .all(|task| task.tags.contains(&"reading".to_string()))
        );
        let fallback = tasks_for_tags(&tasks, &["unknown".to_string()]);
        assert!(
            !fallback.is_empty()
                && fallback
                    .iter()
                    .all(|task| task.tags.contains(&"bug".to_string()))
        );
    }
}
