//! Optional cloud-backed semantic search. Indexing is deliberately never started here.
use crate::tool_run::ToolRunResult;
use claakecode_core::ToolDescriptor;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

pub fn descriptor() -> ToolDescriptor {
    ToolDescriptor {
        name: "mgrep".into(),
        description: "Semantic search using Mixedbread mgrep (cloud-backed, optional). Requires an installed, authenticated mgrep CLI and a manually indexed workspace. Never indexes or starts a watcher. Use grep for exact matches and regex. Enable only with consent to Mixedbread cloud processing and possible usage costs.".into(),
        input_schema: json!({"type":"object","properties":{
            "query":{"type":"string","description":"Natural-language question about the indexed workspace."},
            "limit":{"type":"integer","minimum":1,"maximum":25,"description":"Maximum results (default 10)."}
        },"required":["query"],"additionalProperties":false}),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    query: String,
    #[serde(default = "default_limit")]
    limit: usize,
}
fn default_limit() -> usize {
    10
}

pub async fn run(root: &Path, input: Value) -> ToolRunResult {
    match search(root, input).await {
        Ok(text) => ToolRunResult::ok(text, Vec::new()),
        Err(error) => ToolRunResult::err(error.to_string(), Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_empty_queries_before_launching_cli() {
        assert!(search(Path::new("."), json!({"query":" "}))
            .await
            .unwrap_err()
            .to_string()
            .contains("empty"));
    }

    #[tokio::test]
    async fn rejects_unbounded_results_and_sync_options() {
        assert!(search(Path::new("."), json!({"query":"auth", "limit":26}))
            .await
            .is_err());
        assert!(search(Path::new("."), json!({"query":"auth", "sync":true}))
            .await
            .is_err());
    }
}

async fn search(root: &Path, input: Value) -> anyhow::Result<String> {
    let input: Input = serde_json::from_value(input)?;
    anyhow::ensure!(!input.query.trim().is_empty(), "query must not be empty");
    anyhow::ensure!(
        (1..=25).contains(&input.limit),
        "limit must be between 1 and 25"
    );
    let mut command = Command::new("mgrep");
    command
        .current_dir(root)
        .args([
            "search",
            "-c",
            "-m",
            &input.limit.to_string(),
            "--",
            &input.query,
        ])
        // Override inherited settings: a search must never upload files or invoke an agent.
        .env("MGREP_SYNC", "0")
        .env("MGREP_WEB", "0")
        .env("MGREP_AGENTIC", "0")
        .env("MGREP_ANSWER", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| anyhow::anyhow!("Cannot start mgrep: {e}. Install @mixedbread/mgrep, run mgrep login, then explicitly index this workspace with mgrep watch. Indexing uploads files to Mixedbread; review ignore rules and costs first."))?;
    let mut stdout = child.stdout.take().expect("piped stdout").take(65537);
    let mut stderr = child.stderr.take().expect("piped stderr").take(8193);
    let result = timeout(Duration::from_secs(30), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (out_result, err_result) =
            tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        out_result?;
        err_result?;
        anyhow::ensure!(
            out.len() <= 65536 && err.len() <= 8192,
            "mgrep output exceeded its safety limit; reduce limit"
        );
        let status = child.wait().await?;
        anyhow::ensure!(
            status.success(),
            "mgrep failed: {}",
            String::from_utf8_lossy(&err)
        );
        Ok::<_, anyhow::Error>(String::from_utf8_lossy(&out).into_owned())
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => anyhow::bail!("mgrep timed out after 30 seconds"),
    }
}
