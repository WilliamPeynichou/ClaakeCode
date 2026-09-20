use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{process::Command, time::timeout};

use claakecode_core::ToolDescriptor;

use crate::{
    tool_names,
    tool_run::{diff_snapshots, snapshot_workspace, ToolRunResult},
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT_BYTES: usize = 200_000;

#[derive(Debug, Deserialize)]
struct PythonInput {
    code: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

pub struct PythonTool {
    workspace_root: PathBuf,
}

impl PythonTool {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
        }
    }

    pub fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: tool_names::PYTHON.into(),
            description: "Run Python code for calculations, data processing, and workspace automation. The code runs with the workspace as its default working directory.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": "Python source code to execute." },
                    "cwd": { "type": "string", "description": "Optional working directory inside the workspace." },
                    "timeout_secs": { "type": "integer", "minimum": 1, "maximum": 120, "description": "Maximum execution time. Defaults to 30 seconds." }
                },
                "required": ["code"],
                "additionalProperties": false
            }),
        }
    }

    pub async fn run(&self, input: Value) -> ToolRunResult {
        let parsed: PythonInput = match serde_json::from_value(input) {
            Ok(value) => value,
            Err(err) => {
                return ToolRunResult::err(format!("invalid Python input: {err}"), Vec::new())
            }
        };
        if parsed.code.trim().is_empty() {
            return ToolRunResult::err("Python code cannot be empty", Vec::new());
        }
        let cwd = match self.resolve_cwd(parsed.cwd.as_deref()) {
            Ok(path) => path,
            Err(err) => return ToolRunResult::err(err, Vec::new()),
        };
        let executable = if cfg!(windows) { "python" } else { "python3" };
        let before = snapshot_workspace(&self.workspace_root);
        let duration = parsed
            .timeout_secs
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_TIMEOUT)
            .min(MAX_TIMEOUT);
        let mut command = Command::new(executable);
        command.arg("-").current_dir(cwd).kill_on_drop(true);
        command.stdin(std::process::Stdio::piped());
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                return ToolRunResult::err(
                    format!("unable to start {executable}: {err}"),
                    Vec::new(),
                )
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            if let Err(err) = stdin.write_all(parsed.code.as_bytes()).await {
                return ToolRunResult::err(
                    format!("unable to send Python code: {err}"),
                    Vec::new(),
                );
            }
        }

        let output = match timeout(
            duration.max(Duration::from_secs(1)),
            child.wait_with_output(),
        )
        .await
        {
            Ok(Ok(output)) => output,
            Ok(Err(err)) => {
                return ToolRunResult::err(format!("Python execution failed: {err}"), Vec::new())
            }
            Err(_) => return ToolRunResult::err("Python execution timed out", Vec::new()),
        };
        let stdout = limited_text(&output.stdout);
        let stderr = limited_text(&output.stderr);
        let file_changes = diff_snapshots(before, snapshot_workspace(&self.workspace_root));
        let mut content = String::new();
        if !stdout.is_empty() {
            content.push_str(&stdout);
        }
        if !stderr.is_empty() {
            if !content.is_empty() {
                content.push_str("\n--- stderr ---\n");
            }
            content.push_str(&stderr);
        }
        if content.is_empty() {
            content = format!(
                "Python exited with status {} and produced no output",
                output.status
            );
        }
        if output.status.success() {
            ToolRunResult::ok(content, file_changes)
        } else {
            ToolRunResult::err(
                format!("Python exited with status {}\n{content}", output.status),
                file_changes,
            )
        }
    }

    fn resolve_cwd(&self, raw: Option<&str>) -> Result<PathBuf, String> {
        let candidate = match raw.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) if Path::new(value).is_absolute() => PathBuf::from(value),
            Some(value) => self.workspace_root.join(value),
            None => self.workspace_root.clone(),
        };
        let canonical = candidate.canonicalize().map_err(|err| {
            format!(
                "unable to resolve Python cwd {}: {err}",
                candidate.display()
            )
        })?;
        let root = self
            .workspace_root
            .canonicalize()
            .unwrap_or_else(|_| self.workspace_root.clone());
        if !canonical.starts_with(root) {
            return Err("Python cwd must stay inside the workspace".into());
        }
        Ok(canonical)
    }
}

fn limited_text(bytes: &[u8]) -> String {
    let truncated = bytes.len() > MAX_OUTPUT_BYTES;
    let bytes = &bytes[..bytes.len().min(MAX_OUTPUT_BYTES)];
    let mut text = String::from_utf8_lossy(bytes).trim_end().to_string();
    if truncated {
        text.push_str("\n[output truncated]");
    }
    text
}
