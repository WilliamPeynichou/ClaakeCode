//! Reads and edits the continual-harness state Prime persists (memories, skills, prompt notes,
//! subagent specs). Format and paths follow the pinned Prime sources: a global
//! `<agent dir>/harness/harness_state.json`, and a per-session one under
//! `<sessions dir>/../session-artifacts/<session id>/harness/harness_state.json`.
//! Prime stays the authority; this is a viewer plus explicit user edits, written atomically.
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

const KINDS: [&str; 4] = ["memory", "skill", "prompt", "subagent"];
const MAX_TITLE: usize = 200;
const MAX_CONTENT: usize = 20_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub path: String,
    /// "global" or the id of the RLM conversation the entry belongs to.
    pub scope: String,
    pub scope_label: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    pub version: u64,
}

pub fn global_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join("harness")
}

/// Session-local harness directory implied by a Prime session file.
pub fn local_dir(session_file: &Path) -> Option<PathBuf> {
    let id = session_file.file_stem()?.to_string_lossy().to_string();
    Some(session_file.parent()?.parent()?.join("session-artifacts").join(id).join("harness"))
}

fn state_file(dir: &Path) -> PathBuf {
    dir.join("harness_state.json")
}

fn load(dir: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(state_file(dir)).ok()?).ok()
}

pub fn read_entries(dir: &Path, scope: &str, scope_label: &str) -> Vec<MemoryEntry> {
    let Some(state) = load(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for kind in KINDS {
        let Some(map) = state["entries"][kind].as_object() else { continue };
        for (id, entry) in map {
            let text = |key: &str| entry[key].as_str().unwrap_or_default().to_string();
            out.push(MemoryEntry {
                id: id.clone(),
                kind: kind.to_string(),
                title: text("title"),
                content: text("content"),
                path: text("path"),
                scope: scope.to_string(),
                scope_label: scope_label.to_string(),
                source: text("source"),
                created_at: text("created_at"),
                updated_at: text("updated_at"),
                version: entry["version"].as_u64().unwrap_or(1),
            });
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    out
}

fn write_atomic(dir: &Path, state: &Value) -> Result<()> {
    let target = state_file(dir);
    let tmp = dir.join(format!(".harness_state.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(state)?).context("write harness state")?;
    std::fs::rename(&tmp, &target).context("replace harness state")?;
    Ok(())
}

fn check_kind(kind: &str) -> Result<()> {
    if !KINDS.contains(&kind) {
        bail!("unknown entry kind");
    }
    Ok(())
}

pub fn delete_entry(dir: &Path, kind: &str, id: &str) -> Result<()> {
    check_kind(kind)?;
    let mut state = load(dir).context("no saved memory in this scope")?;
    let removed = state["entries"][kind].as_object_mut().and_then(|m| m.remove(id));
    if removed.is_none() {
        bail!("entry not found");
    }
    write_atomic(dir, &state)
}

pub fn edit_entry(dir: &Path, kind: &str, id: &str, title: &str, content: &str, now: &str) -> Result<()> {
    check_kind(kind)?;
    let (title, content) = (title.trim(), content.trim());
    if title.is_empty() || content.is_empty() {
        bail!("title and content cannot be empty");
    }
    if title.chars().count() > MAX_TITLE || content.chars().count() > MAX_CONTENT {
        bail!("entry is too long");
    }
    let mut state = load(dir).context("no saved memory in this scope")?;
    let entry = state["entries"][kind].get_mut(id).and_then(Value::as_object_mut).context("entry not found")?;
    let version = entry.get("version").and_then(Value::as_u64).unwrap_or(1) + 1;
    entry.insert("title".into(), title.into());
    entry.insert("content".into(), content.into());
    entry.insert("updated_at".into(), now.into());
    entry.insert("source".into(), "user".into());
    entry.insert("version".into(), version.into());
    write_atomic(dir, &state)
}

/// UTC timestamp `YYYY-MM-DDTHH:MM:SS.000Z` from the system clock (no extra dependency).
pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("cc-mem-{}", uuid::Uuid::new_v4()));
        let dir = root.join("harness");
        std::fs::create_dir_all(&dir).unwrap();
        let state = json!({"schema":1,"refinements":[],"entries":{
            "memory":{"m1":{"id":"m1","kind":"memory","title":"Median","content":"use p50","path":"general",
                "source":"agent","created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-02T00:00:00.000Z","version":1,
                "extra":"kept"}},
            "skill":{},"prompt":{},"subagent":{}}});
        std::fs::write(state_file(&dir), serde_json::to_vec(&state).unwrap()).unwrap();
        (root, dir)
    }

    #[test]
    fn reads_edits_and_deletes_atomically_keeping_unknown_fields() {
        let (root, dir) = sample();
        let entries = read_entries(&dir, "global", "Global");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Median");
        edit_entry(&dir, "memory", "m1", " New ", "fixed fact", "2026-02-02T00:00:00.000Z").unwrap();
        let raw = load(&dir).unwrap();
        assert_eq!(raw["entries"]["memory"]["m1"]["extra"], "kept");
        assert_eq!(raw["entries"]["memory"]["m1"]["version"], 2);
        assert_eq!(raw["entries"]["memory"]["m1"]["source"], "user");
        assert!(edit_entry(&dir, "memory", "m1", "", "x", "t").is_err());
        assert!(edit_entry(&dir, "nope", "m1", "a", "b", "t").is_err());
        assert!(delete_entry(&dir, "memory", "missing").is_err());
        delete_entry(&dir, "memory", "m1").unwrap();
        assert!(read_entries(&dir, "global", "Global").is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_dir_follows_prime_session_layout() {
        let dir = local_dir(Path::new("/d/sessions/abc.jsonl")).unwrap();
        assert_eq!(dir, Path::new("/d/session-artifacts/abc/harness"));
        assert_eq!(read_entries(Path::new("/nonexistent/x"), "g", "G"), Vec::new());
    }

    #[test]
    fn iso_clock_is_well_formed() {
        let now = now_iso();
        assert_eq!(now.len(), 24);
        assert!(now.starts_with("20") && now.ends_with(".000Z"));
    }
}
