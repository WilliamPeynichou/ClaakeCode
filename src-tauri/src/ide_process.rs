//! Bounded child-process runner shared by IDE hooks and diagnostics.
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::Notify};

const MAX_OUTPUT_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Finish {
    Exited,
    TimedOut,
    Cancelled,
}

pub(super) struct ProcessResult {
    pub(super) finish: Finish,
    pub(super) exit_code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

async fn read_limited<R: tokio::io::AsyncRead + Unpin>(reader: Option<R>) -> String {
    let Some(reader) = reader else { return String::new() };
    let mut buffer = Vec::new();
    let mut limited = reader.take(MAX_OUTPUT_BYTES);
    let _ = limited.read_to_end(&mut buffer).await;
    // Keep draining so the child never blocks on a full pipe.
    let mut rest = limited.into_inner();
    let mut sink = [0u8; 8192];
    while matches!(rest.read(&mut sink).await, Ok(n) if n > 0) {}
    String::from_utf8_lossy(&buffer).into_owned()
}

pub(super) async fn run(
    program: &str,
    args: &[String],
    cwd: &Path,
    envs: &[(String, String)],
    timeout: Duration,
    cancel: &Notify,
) -> std::io::Result<ProcessResult> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .envs(envs.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn()?;
    let stdout = tokio::spawn(read_limited(child.stdout.take()));
    let stderr = tokio::spawn(read_limited(child.stderr.take()));
    let (finish, exit_code) = tokio::select! {
        status = child.wait() => (Finish::Exited, status?.code()),
        _ = tokio::time::sleep(timeout) => (Finish::TimedOut, None),
        _ = cancel.notified() => (Finish::Cancelled, None),
    };
    if finish != Finish::Exited {
        let _ = child.kill().await;
    }
    Ok(ProcessResult {
        finish,
        exit_code,
        stdout: stdout.await.unwrap_or_default(),
        stderr: stderr.await.unwrap_or_default(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_exit_code_timeout_and_cancel() {
        let cwd = std::env::temp_dir();
        let cancel = Notify::new();
        let args = |script: &str| vec!["-c".to_string(), script.to_string()];

        let done = run("sh", &args("echo out; echo err >&2; exit 3"), &cwd, &[], Duration::from_secs(5), &cancel).await.unwrap();
        assert_eq!((done.finish, done.exit_code), (Finish::Exited, Some(3)));
        assert_eq!((done.stdout.trim(), done.stderr.trim()), ("out", "err"));

        let slow = run("sh", &args("sleep 5"), &cwd, &[], Duration::from_millis(100), &cancel).await.unwrap();
        assert_eq!(slow.finish, Finish::TimedOut);

        cancel.notify_one();
        let stopped = run("sh", &args("sleep 5"), &cwd, &[], Duration::from_secs(5), &cancel).await.unwrap();
        assert_eq!(stopped.finish, Finish::Cancelled);
    }
}
