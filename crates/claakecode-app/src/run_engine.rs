//! Pure core of the guarded run engine: load a graph, hold a run on disk, decide what comes next.
//! Real guard judging (C2) and loop wiring (C4) live elsewhere: here the judge is a parameter.

use std::{
    collections::{BTreeMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_REFUSALS: u32 = 5;
const MAX_STEPS: usize = 20;
const MAX_FILE_CHARS: usize = 20_000;
const MAX_TOTAL_CHARS: usize = 40_000;

fn default_timeout() -> u64 {
    120
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    #[serde(default)]
    pub tags: Vec<String>,
    pub start: String,
    pub steps: BTreeMap<String, Step>,
    pub guards: BTreeMap<String, Guard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    #[serde(default)]
    pub instructions: Vec<String>,
    pub guard: String,
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Guard {
    FileExists { path: String },
    FileContains { path: String, text: String },
    GitCommit { paths: Vec<String> },
    #[serde(rename_all = "camelCase")]
    Command {
        run: String,
        #[serde(default = "default_timeout")]
        timeout_secs: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Active,
    Done,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub graph_sha256: String,
    pub graph_dir: String,
    pub graph: Graph,
    pub status: RunStatus,
    pub step: String,
    pub start_commit: Option<String>,
    #[serde(default)]
    pub refusals: BTreeMap<String, u32>,
    #[serde(default)]
    pub last_reasons: Vec<String>,
    #[serde(default)]
    pub human_note: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub enum GuardVerdict {
    Pass,
    Fail(Vec<String>),
}

/// A guard that just passed after having refused at least once (lot D3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovered {
    pub guard: String,
    /// Reasons of the last refusal.
    pub reasons: Vec<String>,
    pub refusals: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Guard green: next step to play.
    Next { step: String, recovered: Option<Recovered> },
    Refused { guard: String, reasons: Vec<String>, count: u32 },
    /// `count >= MAX_REFUSALS`.
    Escalate { guard: String, reasons: Vec<String> },
    Done { recovered: Option<Recovered> },
}

impl Graph {
    /// Parse and validate a graph; also returns the SHA-256 (hex) of the exact bytes read.
    pub fn parse(bytes: &[u8]) -> Result<(Graph, String)> {
        let graph: Graph = serde_json::from_slice(bytes).context("invalid graph json")?;
        graph.validate()?;
        Ok((graph, format!("{:x}", Sha256::digest(bytes))))
    }

    pub fn validate(&self) -> Result<()> {
        if self.steps.len() > MAX_STEPS {
            bail!("graph has more than {MAX_STEPS} steps");
        }
        if !self.steps.contains_key(&self.start) {
            bail!("start step `{}` not found", self.start);
        }
        for (name, step) in &self.steps {
            if !self.guards.contains_key(&step.guard) {
                bail!("step `{name}` uses unknown guard `{}`", step.guard);
            }
            match &step.next {
                Some(next) if !self.steps.contains_key(next) => {
                    bail!("step `{name}` has unknown next `{next}`")
                }
                None if matches!(
                    self.guards[&step.guard],
                    Guard::FileExists { .. } | Guard::FileContains { .. }
                ) =>
                {
                    bail!("final step `{name}` must use a `command` or `git_commit` guard")
                }
                _ => {}
            }
        }
        for (name, guard) in &self.guards {
            match guard {
                Guard::Command { timeout_secs, .. } if !(1..=900).contains(timeout_secs) => {
                    bail!("guard `{name}`: timeoutSecs must be in 1..=900");
                }
                Guard::GitCommit { paths }
                    if paths.iter().any(|p| Path::new(p).is_absolute() || Path::new(p).components().any(|c| matches!(c, std::path::Component::ParentDir))) =>
                {
                    bail!("guard `{name}`: paths must be relative and without `..`");
                }
                _ => {}
            }
        }
        let mut seen = HashSet::new();
        let mut current = Some(self.start.as_str());
        while let Some(name) = current {
            if !seen.insert(name) {
                bail!("cycle at step `{name}`");
            }
            current = self.steps[name].next.as_deref();
        }
        if let Some(name) = self.steps.keys().find(|name| !seen.contains(name.as_str())) {
            bail!("step `{name}` is unreachable");
        }
        Ok(())
    }
}

/// `<ws>/.claakecode/runs/<conversation_id>.json`. shortcut: an id with characters outside
/// `[A-Za-z0-9_-]` is rewritten to `_` instead of refused (signature returns a plain path), so it can never leave the runs folder.
pub fn run_path(workspace_root: &Path, conversation_id: &str) -> PathBuf {
    let id: String = conversation_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let id = if id.is_empty() { "_".to_string() } else { id };
    workspace_root.join(".claakecode").join("runs").join(format!("{id}.json"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

impl Run {
    pub fn new(graph: Graph, sha: String, graph_dir: String, start_commit: Option<String>) -> Run {
        let now = now_ms();
        Run {
            id: uuid::Uuid::new_v4().to_string(),
            graph_sha256: sha,
            graph_dir,
            step: graph.start.clone(),
            graph,
            status: RunStatus::Active,
            start_commit,
            refusals: BTreeMap::new(),
            last_reasons: Vec::new(),
            human_note: None,
            created_at_ms: now,
            updated_at_ms: now,
        }
    }

    pub fn load(path: &Path) -> Result<Option<Run>> {
        match std::fs::read(path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).context("invalid run file")?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).context("read run file"),
        }
    }

    /// Atomic: temp file in the same folder, then rename.
    pub fn save(&self, path: &Path) -> Result<()> {
        let dir = path.parent().context("run path has no parent")?;
        std::fs::create_dir_all(dir).context("create runs folder")?;
        let tmp = dir.join(format!(".run.{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?).context("write run file")?;
        std::fs::rename(&tmp, path).context("replace run file")?;
        Ok(())
    }
}

/// Judge the guard of `run.step`, skipping green steps. Does not save: the caller does.
pub async fn advance_with<F, Fut>(run: &mut Run, mut judge: F) -> Verdict
where
    F: FnMut(&Guard) -> Fut,
    Fut: Future<Output = GuardVerdict>,
{
    let mut first = true;
    let mut recovered = None;
    loop {
        let Some(step) = run.graph.steps.get(&run.step).cloned() else {
            return Verdict::Escalate { guard: String::new(), reasons: vec![format!("unknown step `{}`", run.step)] };
        };
        let Some(guard) = run.graph.guards.get(&step.guard).cloned() else {
            return Verdict::Escalate {
                guard: step.guard.clone(),
                reasons: vec![format!("unknown guard `{}`", step.guard)],
            };
        };
        run.updated_at_ms = now_ms();
        match judge(&guard).await {
            GuardVerdict::Pass => {
                let refusals = run.refusals.get(&step.guard).copied().unwrap_or(0);
                if first && refusals > 0 {
                    recovered = Some(Recovered {
                        guard: step.guard.clone(),
                        reasons: run.last_reasons.clone(),
                        refusals,
                    });
                }
                run.refusals.insert(step.guard.clone(), 0);
                run.last_reasons.clear();
                run.human_note = None;
                match step.next {
                    None => {
                        run.status = RunStatus::Done;
                        return Verdict::Done { recovered };
                    }
                    Some(next) => {
                        run.step = next;
                        first = false;
                    }
                }
            }
            GuardVerdict::Fail(reasons) => {
                // A step just reached is work to do, not a failure.
                if !first {
                    return Verdict::Next { step: run.step.clone(), recovered };
                }
                let count = run.refusals.entry(step.guard.clone()).or_insert(0);
                *count += 1;
                let count = *count;
                run.last_reasons = reasons.clone();
                return if count >= MAX_REFUSALS {
                    Verdict::Escalate { guard: step.guard, reasons }
                } else {
                    Verdict::Refused { guard: step.guard, reasons, count }
                };
            }
        }
    }
}

const MAX_JUDGE_FILE_BYTES: u64 = 1024 * 1024;
const MAX_REASON_CHARS: usize = 2_000;

fn fail(reason: impl Into<String>) -> GuardVerdict {
    GuardVerdict::Fail(vec![reason.into()])
}

fn tail_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(max)).collect()
}

pub fn head_commit(workspace_root: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(workspace_root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !sha.is_empty()).then_some(sha)
}

/// Run `program args` in the workspace: null stdin, merged output, killed on timeout.
async fn run_bounded(
    mut command: tokio::process::Command,
    workspace_root: &Path,
    timeout_secs: u64,
) -> std::result::Result<(bool, String), String> {
    use std::process::Stdio;
    command
        .current_dir(workspace_root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command.spawn().map_err(|error| format!("spawn failed: {error}"))?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| format!("command timed out after {timeout_secs}s"))?
        .map_err(|error| format!("wait failed: {error}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok((output.status.success(), text))
}

/// Judge one guard against the disk. Never trusts the model.
pub async fn judge(guard: &Guard, workspace_root: &Path, start_commit: Option<&str>) -> GuardVerdict {
    use crate::workspace::resolve_workspace_path;
    let canonical_root = workspace_root.canonicalize().unwrap_or_else(|_| workspace_root.to_path_buf());
    let workspace_root = canonical_root.as_path();
    match guard {
        Guard::FileExists { path } => match resolve_workspace_path(workspace_root, path) {
            Ok(file) if file.is_file() => GuardVerdict::Pass,
            _ => fail(format!("missing file {path}")),
        },
        Guard::FileContains { path, text } => {
            let Ok(file) = resolve_workspace_path(workspace_root, path) else {
                return fail(format!("missing file {path}"));
            };
            let Ok(handle) = std::fs::File::open(&file) else {
                return fail(format!("missing file {path}"));
            };
            let mut bytes = Vec::new();
            if std::io::Read::read_to_end(&mut std::io::Read::take(handle, MAX_JUDGE_FILE_BYTES), &mut bytes).is_err() {
                return fail(format!("cannot read {path}"));
            }
            if String::from_utf8_lossy(&bytes).contains(text.as_str()) {
                GuardVerdict::Pass
            } else {
                fail(format!("{path} does not contain the expected text"))
            }
        }
        Guard::GitCommit { paths } => {
            let Some(start) = start_commit else {
                return fail("workspace has no git commit to compare with");
            };
            let mut command = tokio::process::Command::new("git");
            command.args(["log", "--format=%H", &format!("{start}..HEAD"), "--"]).args(paths);
            match run_bounded(command, workspace_root, 30).await {
                Ok((true, out)) if !out.trim().is_empty() => GuardVerdict::Pass,
                Ok((true, _)) => fail("no new commit touching the expected paths"),
                Ok((false, out)) => fail(tail_chars(out.trim(), MAX_REASON_CHARS)),
                Err(reason) => fail(reason),
            }
        }
        Guard::Command { run, timeout_secs } => {
            #[cfg(windows)]
            {
                let _ = (run, timeout_secs);
                fail("command guards are not supported on Windows yet")
            }
            #[cfg(not(windows))]
            {
                let (program, args) =
                    crate::sandbox::wrap(workspace_root, "/bin/bash", &["-lc".into(), run.clone()]);
                let mut command = tokio::process::Command::new(program);
                command.args(args);
                match run_bounded(command, workspace_root, *timeout_secs).await {
                    Ok((true, _)) => GuardVerdict::Pass,
                    Ok((false, out)) => fail(tail_chars(out.trim(), MAX_REASON_CHARS)),
                    Err(reason) => fail(reason),
                }
            }
        }
    }
}

/// `advance_with` + real `judge`. Does not save.
pub async fn advance(run: &mut Run, workspace_root: &Path) -> Verdict {
    let start = run.start_commit.clone();
    advance_with(run, |guard| {
        let guard = guard.clone();
        let start = start.clone();
        async move { judge(&guard, workspace_root, start.as_deref()).await }
    })
    .await
}

/// Instruction files of the current step (relative to `graph_dir`, kept inside it), then the human note.
pub fn step_instruction(run: &Run) -> Result<String> {
    let step = run.graph.steps.get(&run.step).context("unknown step")?;
    let root = Path::new(&run.graph_dir).canonicalize().context("graph dir")?;
    let mut out = String::new();
    let mut total = 0usize;
    for rel in &step.instructions {
        let file = root.join(rel).canonicalize().with_context(|| format!("instruction file `{rel}`"))?;
        if !file.starts_with(&root) {
            bail!("instruction file `{rel}` is outside the graph folder");
        }
        let text = std::fs::read_to_string(&file).with_context(|| format!("read `{rel}`"))?;
        let text: String = text.chars().take(MAX_FILE_CHARS).collect();
        total += text.chars().count();
        if total > MAX_TOTAL_CHARS {
            bail!("step instructions exceed {MAX_TOTAL_CHARS} characters");
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&text);
    }
    if let Some(note) = &run.human_note {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(note);
    }
    Ok(out)
}

pub fn system_block(run: &Run) -> String {
    let guard = run.graph.steps.get(&run.step).map(|s| s.guard.as_str()).unwrap_or("?");
    let reasons = if run.last_reasons.is_empty() { "none".to_string() } else { run.last_reasons.join("; ") };
    format!(
        "<run_state>\nrun: {} | step: {} | guard: {}\nlast refusal: {}\n</run_state>",
        run.id, run.step, guard, reasons
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn graph(json: &str) -> Graph {
        Graph::parse(json.as_bytes()).unwrap().0
    }

    const THREE: &str = r#"{"start":"1","steps":{
        "1":{"guard":"g1","next":"2"},
        "2":{"guard":"g2","next":"3"},
        "3":{"guard":"g3"}},
      "guards":{"g1":{"type":"file_exists","path":"a"},"g2":{"type":"file_exists","path":"b"},
                "g3":{"type":"command","run":"true"}}}"#;

    fn run_of(json: &str) -> Run {
        Run::new(graph(json), "sha".into(), ".".into(), None)
    }

    /// Fake judge: path/run key -> green?
    fn table(entries: &[(&str, bool)]) -> impl FnMut(&Guard) -> std::future::Ready<GuardVerdict> {
        let map: HashMap<String, bool> = entries.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        move |guard| {
            let key = match guard {
                Guard::FileExists { path } => path.clone(),
                Guard::Command { run, .. } => run.clone(),
                _ => String::new(),
            };
            std::future::ready(if map.get(&key).copied().unwrap_or(false) {
                GuardVerdict::Pass
            } else {
                GuardVerdict::Fail(vec![format!("{key} red")])
            })
        }
    }

    #[tokio::test]
    async fn skips_green_steps() {
        let mut run = run_of(THREE);
        let verdict = advance_with(&mut run, table(&[("a", true), ("b", false)])).await;
        assert_eq!(verdict, Verdict::Next { step: "2".into(), recovered: None });
        assert_eq!(run.step, "2");
        assert!(run.refusals.get("g2").copied().unwrap_or(0) == 0);
    }

    #[tokio::test]
    async fn counts_refusals_and_escalates() {
        let mut run = run_of(THREE);
        for expected in 1..MAX_REFUSALS {
            let verdict = advance_with(&mut run, table(&[("a", false)])).await;
            assert!(matches!(verdict, Verdict::Refused { count, .. } if count == expected));
        }
        let verdict = advance_with(&mut run, table(&[("a", false)])).await;
        assert!(matches!(verdict, Verdict::Escalate { .. }));
        assert_eq!(run.refusals["g1"], MAX_REFUSALS);
    }

    /// Lot D3: the verdict carries the refusal that was just fixed.
    #[tokio::test]
    async fn recovered_reports_refusals_before_reset() {
        let mut run = run_of(THREE);
        advance_with(&mut run, table(&[("a", false)])).await;
        advance_with(&mut run, table(&[("a", false)])).await;
        let verdict = advance_with(&mut run, table(&[("a", true), ("b", false)])).await;
        let Verdict::Next { step, recovered: Some(recovered) } = verdict else { panic!("{verdict:?}") };
        assert_eq!(step, "2");
        assert_eq!((recovered.guard.as_str(), recovered.refusals), ("g1", 2));
        assert_eq!(recovered.reasons, vec!["a red".to_string()]);
        assert_eq!(run.refusals["g1"], 0);
    }

    #[tokio::test]
    async fn done_on_final_green() {
        let mut run = run_of(THREE);
        let verdict = advance_with(&mut run, table(&[("a", true), ("b", true), ("true", true)])).await;
        assert_eq!(verdict, Verdict::Done { recovered: None });
        assert_eq!(run.status, RunStatus::Done);
    }

    #[tokio::test]
    async fn reload_keeps_position() {
        let dir = std::env::temp_dir().join(format!("claakecode-run-engine-{}", uuid::Uuid::new_v4()));
        let path = run_path(&dir, "conv-1");
        let mut run = run_of(THREE);
        advance_with(&mut run, table(&[("a", true), ("b", false)])).await;
        advance_with(&mut run, table(&[("b", false)])).await;
        run.save(&path).unwrap();
        let loaded = Run::load(&path).unwrap().unwrap();
        assert_eq!(loaded.step, "2");
        assert_eq!(loaded.refusals, run.refusals);
        assert!(Run::load(&run_path(&dir, "missing")).unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validate_rejects() {
        let cycle = r#"{"start":"1","steps":{"1":{"guard":"g","next":"2"},"2":{"guard":"g","next":"1"}},
            "guards":{"g":{"type":"command","run":"true"}}}"#;
        assert!(Graph::parse(cycle.as_bytes()).unwrap_err().to_string().contains("cycle"));
        let unknown = r#"{"start":"1","steps":{"1":{"guard":"nope"}},
            "guards":{"g":{"type":"command","run":"true"}}}"#;
        assert!(Graph::parse(unknown.as_bytes()).unwrap_err().to_string().contains("unknown guard"));
        let final_contains = r#"{"start":"1","steps":{"1":{"guard":"g"}},
            "guards":{"g":{"type":"file_contains","path":"a","text":"b"}}}"#;
        assert!(Graph::parse(final_contains.as_bytes()).is_err());
        assert!(Graph::parse(THREE.as_bytes()).is_ok());
    }

    fn git_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("claakecode-guards-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sh = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        sh(&["init", "-q"]);
        std::fs::write(dir.join("init.txt"), "x").unwrap();
        sh(&["add", "."]);
        sh(&["commit", "-q", "-m", "init"]);
        dir
    }

    fn is_pass(v: &GuardVerdict) -> bool {
        matches!(v, GuardVerdict::Pass)
    }

    #[tokio::test]
    async fn file_exists_guard() {
        let dir = git_repo();
        let g = Guard::FileExists { path: "a.txt".into() };
        assert!(!is_pass(&judge(&g, &dir, None).await));
        std::fs::write(dir.join("a.txt"), "hi").unwrap();
        assert!(is_pass(&judge(&g, &dir, None).await));
        let escape = Guard::FileExists { path: "../x".into() };
        assert!(!is_pass(&judge(&escape, &dir, None).await));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn file_contains_guard() {
        let dir = git_repo();
        let g = Guard::FileContains { path: "a.txt".into(), text: "needle".into() };
        std::fs::write(dir.join("a.txt"), "hay").unwrap();
        assert!(!is_pass(&judge(&g, &dir, None).await));
        std::fs::write(dir.join("a.txt"), "hay needle hay").unwrap();
        assert!(is_pass(&judge(&g, &dir, None).await));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn git_commit_guard() {
        let dir = git_repo();
        let start = head_commit(&dir).unwrap();
        let g = Guard::GitCommit { paths: vec!["b.txt".into()] };
        assert!(!is_pass(&judge(&g, &dir, None).await));
        assert!(!is_pass(&judge(&g, &dir, Some(&start)).await));
        std::fs::write(dir.join("b.txt"), "b").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-q", "-m", "b"]] {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(&args)
                .current_dir(&dir)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok);
        }
        assert!(is_pass(&judge(&g, &dir, Some(&start)).await));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn command_guard() {
        let dir = git_repo();
        let g = Guard::Command { run: "test -f ok.txt || { echo nope; exit 1; }".into(), timeout_secs: 10 };
        match judge(&g, &dir, None).await {
            GuardVerdict::Fail(reasons) => assert!(reasons[0].contains("nope")),
            GuardVerdict::Pass => panic!("should be red"),
        }
        std::fs::write(dir.join("ok.txt"), "").unwrap();
        assert!(is_pass(&judge(&g, &dir, None).await));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn command_guard_times_out() {
        let dir = git_repo();
        let g = Guard::Command { run: "sleep 5".into(), timeout_secs: 1 };
        match judge(&g, &dir, None).await {
            GuardVerdict::Fail(reasons) => assert_eq!(reasons[0], "command timed out after 1s"),
            GuardVerdict::Pass => panic!("should time out"),
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validate_rejects_git_commit_bad_paths() {
        for bad in ["/etc/passwd", "../x", "a/../../x"] {
            let json = format!(
                r#"{{"start":"1","steps":{{"1":{{"guard":"g"}}}},"guards":{{"g":{{"type":"git_commit","paths":["{bad}"]}}}}}}"#
            );
            assert!(Graph::parse(json.as_bytes()).is_err(), "{bad}");
        }
        let ok = r#"{"start":"1","steps":{"1":{"guard":"g"}},"guards":{"g":{"type":"git_commit","paths":["src/a.rs"]}}}"#;
        assert!(Graph::parse(ok.as_bytes()).is_ok());
    }
}
