//! Write sandbox for the `bash` and `python` tools and for `Command` run guards (lot A2a).
//!
//! macOS: the process runs under `sandbox-exec` with a profile that denies every
//! file write outside the workspace, the temp dirs and a few tool caches. Reads and network are
//! untouched. Disabled, or on another platform, `wrap` returns its input unchanged.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static ENABLED: AtomicBool = AtomicBool::new(false);

/// Tests that flip the global switch hold this lock, so one cannot disable it under another.
#[cfg(test)]
pub(crate) static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Applied at startup from the `sandbox_enabled` setting, and on every change.
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Program and arguments to actually spawn for `program args..` in `workspace_root`.
pub fn wrap(workspace_root: &Path, program: &str, args: &[String]) -> (String, Vec<String>) {
    #[cfg(target_os = "macos")]
    if is_enabled() && Path::new(SANDBOX_EXEC).is_file() {
        let mut wrapped = vec!["-p".to_string(), profile(workspace_root), program.to_string()];
        wrapped.extend(args.iter().cloned());
        return (SANDBOX_EXEC.to_string(), wrapped);
    }
    #[cfg(target_os = "linux")]
    if is_enabled() {
        if let Some(bwrap) = bwrap_path() {
            return (bwrap, bwrap_args(workspace_root, program, args));
        }
        static WARNED: std::sync::Once = std::sync::Once::new();
        WARNED.call_once(|| tracing::warn!("write sandbox is on but `bwrap` is not installed: commands run unsandboxed"));
    }
    let _ = workspace_root;
    (program.to_string(), args.to_vec())
}

#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Lot A2b: first `bwrap` found in PATH.
#[cfg(target_os = "linux")]
fn bwrap_path() -> Option<String> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join("bwrap"))
        .find(|path| path.is_file())
        .map(|path| path.display().to_string())
}

/// Lot A2b: whole filesystem read-only, then the writable directories bound read-write.
#[cfg(target_os = "linux")]
pub fn bwrap_args(workspace_root: &Path, program: &str, args: &[String]) -> Vec<String> {
    let mut out: Vec<String> =
        ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"].iter().map(|s| s.to_string()).collect();
    // `--bind` needs an existing directory.
    for dir in writable_dirs(workspace_root, &[PathBuf::from("/tmp")]).into_iter().filter(|dir| dir.is_dir()) {
        let dir = dir.display().to_string();
        out.extend(["--bind".to_string(), dir.clone(), dir]);
    }
    out.push("--die-with-parent".to_string());
    out.push(program.to_string());
    out.extend(args.iter().cloned());
    out
}

/// Seatbelt profile: everything allowed except writes outside the listed directories.
#[cfg(target_os = "macos")]
pub fn profile(workspace_root: &Path) -> String {
    let system = [
        PathBuf::from("/private/tmp"),
        PathBuf::from("/private/var/folders"),
        PathBuf::from("/dev"),
    ];
    let writable = writable_dirs(workspace_root, &system);
    let subpaths: Vec<String> = writable.iter().map(|path| format!("(subpath \"{}\")", escape(path))).collect();
    format!(
        "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* {})\n",
        subpaths.join(" ")
    )
}

/// Workspace, the platform's temp directories, existing tool caches, and the git common dir
/// of a worktree when it lives outside the workspace.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn writable_dirs(workspace_root: &Path, system: &[PathBuf]) -> Vec<PathBuf> {
    let workspace = canonical(workspace_root);
    let mut writable = vec![workspace.clone()];
    writable.extend(system.iter().cloned());
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for cache in [".cargo", ".npm", ".cache", "Library/Caches"] {
            let dir = home.join(cache);
            if dir.is_dir() {
                writable.push(canonical(&dir));
            }
        }
    }
    // A git worktree keeps its real `.git` in the main repository, outside the workspace.
    if let Some(git_dir) = git_common_dir(&workspace) {
        if !git_dir.starts_with(&workspace) {
            writable.push(git_dir);
        }
    }
    writable
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(target_os = "macos")]
fn escape(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn git_common_dir(workspace: &Path) -> Option<PathBuf> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    let path = if path.is_absolute() { path } else { workspace.join(path) };
    std::fs::canonicalize(path).ok()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn sandbox_profile_lists_canonical_workspace_and_escapes_quotes() {
        let dir = std::env::temp_dir().join(format!("claakecode-sandbox-\"q-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let text = profile(&dir);
        let canonical = std::fs::canonicalize(&dir).unwrap();
        assert!(text.contains("(deny file-write*)"));
        assert!(text.contains(&format!("(subpath \"{}\")", escape(&canonical))));
        assert!(text.contains("\\\"q-"));
        assert!(text.contains("(subpath \"/private/tmp\")"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sandbox_wrap_is_identity_when_disabled() {
        // Never enabled in this test: other tests own the global switch.
        if is_enabled() {
            return;
        }
        let (program, args) = wrap(Path::new("/tmp"), "/bin/bash", &["-lc".into(), "true".into()]);
        assert_eq!(program, "/bin/bash");
        assert_eq!(args, vec!["-lc".to_string(), "true".to_string()]);
    }
}

/// Lot A2b. Never run on the development machine (macOS): Linux only.
#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;

    #[test]
    fn sandbox_bwrap_blocks_writes_outside_workspace() {
        let Some(bwrap) = bwrap_path() else { return };
        let home = PathBuf::from(std::env::var_os("HOME").expect("HOME"));
        let workspace = std::env::temp_dir().join(format!("claakecode-bwrap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let outside = home.join(format!("claakecode-sandbox-{}", uuid::Uuid::new_v4()));
        let script = format!("touch ok; touch '{}'; true", outside.display());
        let args = bwrap_args(&workspace, "/bin/bash", &["-lc".into(), script]);
        let status = std::process::Command::new(bwrap).args(args).current_dir(&workspace).status().unwrap();
        let leaked = outside.exists();
        let _ = std::fs::remove_file(&outside);
        assert!(status.success());
        assert!(workspace.join("ok").exists());
        assert!(!leaked);
        let _ = std::fs::remove_dir_all(workspace);
    }
}
