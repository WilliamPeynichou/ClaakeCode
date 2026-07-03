use std::{path::PathBuf, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{process::Command, time::timeout};

pub const CAVEMAN_SETTINGS_KEY: &str = "caveman_settings";
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS: u64 = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CavemanSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_manual_activation_only")]
    pub manual_activation_only: bool,
    #[serde(default)]
    pub executable: String,
    #[serde(default)]
    pub repo_path: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

impl Default for CavemanSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            manual_activation_only: true,
            executable: String::new(),
            repo_path: String::new(),
            extra_args: Vec::new(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

impl CavemanSettings {
    pub fn normalized(mut self) -> Self {
        self.manual_activation_only = true;
        self.executable = self.executable.trim().to_string();
        self.repo_path = self.repo_path.trim().to_string();
        self.extra_args = self
            .extra_args
            .into_iter()
            .map(|arg| arg.trim().to_string())
            .filter(|arg| !arg.is_empty())
            .collect();
        self.timeout_ms = self.timeout_ms.clamp(1_000, 600_000);
        self
    }

    fn command_program(&self) -> &str {
        if self.executable.trim().is_empty() {
            "caveman"
        } else {
            self.executable.trim()
        }
    }

    fn working_dir(&self) -> Option<PathBuf> {
        let repo_path = self.repo_path.trim();
        if repo_path.is_empty() {
            None
        } else {
            Some(PathBuf::from(repo_path))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CavemanActivationInput {
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CavemanAvailability {
    pub configured: bool,
    pub available: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CavemanRunOutcome {
    pub ok: bool,
    pub message: String,
    pub output: Option<String>,
}

pub async fn probe_caveman(settings: &CavemanSettings) -> CavemanAvailability {
    let settings = settings.clone().normalized();
    if !settings.enabled {
        return CavemanAvailability {
            configured: false,
            available: false,
            message: "Caveman is disabled by default. Enable it in Settings, then opt in per task.".to_string(),
        };
    }

    let mut command = Command::new(settings.command_program());
    command.arg("--version");
    if let Some(cwd) = settings.working_dir() {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    match timeout(Duration::from_millis(DEFAULT_PROBE_TIMEOUT_MS), command.output()).await {
        Ok(Ok(output)) if output.status.success() => CavemanAvailability {
            configured: true,
            available: true,
            message: first_non_empty_line(&output.stdout, &output.stderr)
                .unwrap_or_else(|| "Caveman is available.".to_string()),
        },
        Ok(Ok(output)) => CavemanAvailability {
            configured: true,
            available: false,
            message: first_non_empty_line(&output.stderr, &output.stdout)
                .unwrap_or_else(|| format!("Caveman probe failed with status {}.", output.status)),
        },
        Ok(Err(err)) => CavemanAvailability {
            configured: true,
            available: false,
            message: format!("Caveman is not available: {err}"),
        },
        Err(_) => CavemanAvailability {
            configured: true,
            available: false,
            message: "Caveman probe timed out.".to_string(),
        },
    }
}

pub async fn run_caveman_for_task(
    settings: &CavemanSettings,
    prompt: &str,
) -> CavemanRunOutcome {
    let settings = settings.clone().normalized();
    if !settings.enabled {
        return CavemanRunOutcome {
            ok: false,
            message: "Caveman was requested manually, but it is disabled in Settings. Continuing with ClaakeCode standard mode.".to_string(),
            output: None,
        };
    }

    let availability = probe_caveman(&settings).await;
    if !availability.available {
        return CavemanRunOutcome {
            ok: false,
            message: format!(
                "Caveman was requested manually, but it is unavailable: {} Continuing with ClaakeCode standard mode.",
                availability.message
            ),
            output: None,
        };
    }

    let mut command = Command::new(settings.command_program());
    command.args(&settings.extra_args).arg(prompt);
    if let Some(cwd) = settings.working_dir() {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    match timeout(Duration::from_millis(settings.timeout_ms), command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            let text = output_text(&output.stdout, &output.stderr);
            CavemanRunOutcome {
                ok: true,
                message: "Caveman completed for this manually activated task.".to_string(),
                output: Some(if text.trim().is_empty() {
                    "Caveman completed without output.".to_string()
                } else {
                    text
                }),
            }
        }
        Ok(Ok(output)) => CavemanRunOutcome {
            ok: false,
            message: format!(
                "Caveman failed with status {}. Continuing with ClaakeCode standard mode.",
                output.status
            ),
            output: Some(output_text(&output.stdout, &output.stderr)).filter(|text| !text.trim().is_empty()),
        },
        Ok(Err(err)) => CavemanRunOutcome {
            ok: false,
            message: format!("Caveman could not be started: {err}. Continuing with ClaakeCode standard mode."),
            output: None,
        },
        Err(_) => CavemanRunOutcome {
            ok: false,
            message: "Caveman timed out. Continuing with ClaakeCode standard mode.".to_string(),
            output: None,
        },
    }
}

fn default_manual_activation_only() -> bool {
    true
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn first_non_empty_line(primary: &[u8], secondary: &[u8]) -> Option<String> {
    for bytes in [primary, secondary] {
        let text = String::from_utf8_lossy(bytes);
        if let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) {
            return Some(line.to_string());
        }
    }
    None
}

fn output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n\n{stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_disabled_manual_only() {
        let settings = CavemanSettings::default();
        assert!(!settings.enabled);
        assert!(settings.manual_activation_only);
    }

    #[test]
    fn normalization_forces_manual_activation_only() {
        let settings = CavemanSettings {
            enabled: true,
            manual_activation_only: false,
            executable: " caveman ".into(),
            repo_path: " /tmp/caveman ".into(),
            extra_args: vec!["  run ".into(), "".into()],
            timeout_ms: 10,
        }
        .normalized();
        assert!(settings.manual_activation_only);
        assert_eq!(settings.executable, "caveman");
        assert_eq!(settings.repo_path, "/tmp/caveman");
        assert_eq!(settings.extra_args, vec!["run"]);
        assert_eq!(settings.timeout_ms, 1_000);
    }
}
