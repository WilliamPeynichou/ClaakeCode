//! Managed skill repositories: full Git checkouts whose skills keep their resources.
//! Cloning only reads the repository: hooks, scripts and dependency installers never run.
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::skill::{list_installed_skills_with, parse_frontmatter, SkillSettings};

const SKILL_FILE: &str = "SKILL.md";
const MANIFEST_FILE: &str = "repositories.json";
const MAX_ENTRIES: usize = 30_000;
const MAX_DEPTH: usize = 32;
const MAX_SKILL_BYTES: u64 = 1_048_576;
const CLONE_TIMEOUT: Duration = Duration::from_secs(120);

/// Serializes mutations only. Reads need no lock: the manifest is replaced atomically.
static MUTATIONS: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    MUTATIONS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySkill {
    pub name: String,
    pub description: Option<String>,
    pub relative_path: String,
    pub absolute_path: String,
    /// Same name as another enabled skill: visible here, never given to the agent.
    pub conflict: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRepository {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    /// Replace the installed copy automatically (at startup and every 6 hours).
    pub auto_update: bool,
    pub revision: String,
    pub absolute_path: String,
    pub skills: Vec<RepositorySkill>,
    pub warnings: Vec<String>,
}

/// Outcome of one update: the repository as now installed, plus what changed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRepositoryUpdateReport {
    pub repository: SkillRepository,
    pub previous_revision: String,
    pub new_revision: String,
    pub added_skills: Vec<String>,
    pub removed_skills: Vec<String>,
    pub updated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRepositoryUpdateError {
    pub id: String,
    pub name: String,
    pub message: String,
}

/// Batch update: `reports` lists only repositories that actually changed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRepositoryUpdateAllReport {
    pub reports: Vec<SkillRepositoryUpdateReport>,
    pub errors: Vec<SkillRepositoryUpdateError>,
}

/// Result of comparing the installed revision with the remote default branch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamStatus {
    pub id: String,
    pub update_available: bool,
    pub installed_revision: String,
    pub remote_revision: String,
}

/// One manifest entry. `checkout` names the immutable generation folder inside `<id>/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    id: String,
    name: String,
    url: String,
    enabled: bool,
    #[serde(default)]
    auto_update: bool,
    revision: String,
    checkout: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    #[serde(default)]
    repositories: Vec<Record>,
}

/// `~/.claakecode/skill-repositories`, owned by Claake Code.
pub fn storage_root() -> Result<PathBuf> {
    Ok(BaseDirs::new()
        .context("unable to locate home directory")?
        .home_dir()
        .join(".claakecode")
        .join("skill-repositories"))
}

fn check_id(value: &str) -> Result<()> {
    let canonical = Uuid::parse_str(value).map(|uuid| uuid.hyphenated().to_string());
    if canonical.as_deref() != Ok(value) {
        bail!("invalid repository identifier");
    }
    Ok(())
}

fn read_manifest(root: &Path) -> Result<Manifest> {
    let path = root.join(MANIFEST_FILE);
    if !path.exists() {
        return Ok(Manifest::default());
    }
    // A corrupt manifest is an error, never replaced silently: that would drop installed repositories.
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(&path)?).context("invalid skill repository manifest")?;
    for record in &manifest.repositories {
        check_id(&record.id)?;
        check_id(&record.checkout)?;
    }
    Ok(manifest)
}

fn save_manifest(root: &Path, manifest: &Manifest) -> Result<()> {
    fs::create_dir_all(root)?;
    let temporary = root.join(format!(".manifest-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(manifest)?)?;
        file.sync_all()?;
        fs::rename(&temporary, root.join(MANIFEST_FILE))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn checkout_path(root: &Path, record: &Record) -> PathBuf {
    root.join(&record.id).join(&record.checkout)
}

fn ensure_plain_dir(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).context("repository storage is missing")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("unsafe repository directory");
    }
    Ok(())
}

/// Accepts HTTPS and SSH Git URLs. Absolute local paths only when `allow_local` (tests).
/// Refuses anything git could read as an option, a transport helper or embedded credentials.
fn normalized_url(input: &str, allow_local: bool) -> Result<String> {
    let input = input.trim();
    if input.is_empty() || input.starts_with('-') || input.chars().any(char::is_control) {
        bail!("a Git HTTPS or SSH URL is required");
    }
    if allow_local && Path::new(input).is_absolute() {
        return Ok(input.to_string());
    }
    if input.starts_with("git@") && !input.contains("://") {
        let (host, path) = input[4..].split_once(':').context("invalid SSH Git URL")?;
        let host_ok = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
        if !host_ok || path.is_empty() || path.starts_with('-') {
            bail!("invalid SSH Git URL");
        }
        return Ok(input.trim_end_matches('/').to_string());
    }
    let url = reqwest::Url::parse(input).context("invalid Git URL")?;
    let host = url.host_str().unwrap_or_default();
    let host_ok = !host.is_empty()
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'));
    let ok = matches!(url.scheme(), "https" | "ssh")
        && host_ok
        && url.password().is_none()
        && (url.scheme() == "ssh" || url.username().is_empty())
        && url.query().is_none()
        && url.fragment().is_none();
    if !ok {
        bail!("only HTTPS and SSH Git URLs without embedded credentials, query or fragment are supported");
    }
    Ok(input.trim_end_matches('/').to_string())
}

fn same_url(left: &str, right: &str) -> bool {
    left.trim_end_matches('/').trim_end_matches(".git") == right.trim_end_matches('/').trim_end_matches(".git")
}

fn repository_name_from_url(url: &str) -> String {
    let name = url.trim_end_matches('/').rsplit(['/', ':']).next().unwrap_or_default().trim_end_matches(".git");
    if name.is_empty() {
        "repository".to_string()
    } else {
        name.to_string()
    }
}

/// Git invocation ignoring user/system configuration, hooks, credential helpers and submodules.
fn git_command(allow_local: bool) -> Command {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -F /dev/null -oBatchMode=yes -oStrictHostKeyChecking=yes")
        .args([
            "-c", "core.hooksPath=/dev/null",
            "-c", "credential.helper=",
            "-c", "protocol.allow=never",
            "-c", "protocol.https.allow=always",
            "-c", "protocol.ssh.allow=always",
            "-c", "submodule.recurse=false",
        ]);
    if allow_local {
        command.args(["-c", "protocol.file.allow=always"]);
    }
    command
}

/// Full clone into a fresh `target`. Returns the checked-out revision.
fn clone_into(url: &str, target: &Path, log: &Path, allow_local: bool) -> Result<String> {
    let log_file = fs::OpenOptions::new().create_new(true).write(true).open(log)?;
    let mut command = git_command(allow_local);
    command
        .args([
            "clone",
            "--no-checkout",
            "--depth=1",
            "--no-recurse-submodules",
            "--template=",
            "--",
            url,
        ])
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log_file);
    let mut child = command.spawn().context("unable to start Git; install Git to import repositories")?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > CLONE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Git clone timed out after 120 seconds");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    if !status.success() {
        let message: String = fs::read_to_string(log).unwrap_or_default().chars().take(4000).collect();
        bail!("Git clone failed: {}", message.trim());
    }
    let output = git_command(allow_local)
        .arg("-C")
        .arg(target)
        .args(["rev-parse", "HEAD"])
        .output()
        .context("unable to read cloned revision")?;
    if !output.status.success() {
        bail!("unable to identify cloned revision");
    }
    let revision = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Refuse repositories that are not skill repositories before writing any file to disk.
    ensure_repository_has_skill_files(target, allow_local)?;

    let checkout = git_command(allow_local)
        .arg("-C")
        .arg(target)
        .args(["checkout", "--force", "HEAD"])
        .stdin(Stdio::null())
        .output()
        .context("unable to check out the repository")?;
    if !checkout.status.success() {
        let message: String = String::from_utf8_lossy(&checkout.stderr).chars().take(4000).collect();
        bail!("Git checkout failed: {}", message.trim());
    }
    Ok(revision)
}

const NOT_A_SKILL_REPOSITORY: &str =
    "This repository does not look like a skills repository: no SKILL.md file with a valid header (name/description) was found. Nothing was installed.";

/// Inspect the committed tree (no checkout yet) and require at least one regular `SKILL.md` blob.
fn ensure_repository_has_skill_files(target: &Path, allow_local: bool) -> Result<()> {
    let output = git_command(allow_local)
        .arg("-C")
        .arg(target)
        .args(["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
        .stdin(Stdio::null())
        .output()
        .context("unable to inspect the repository content")?;
    if !output.status.success() {
        bail!("unable to inspect the repository content");
    }
    let mut entries = 0usize;
    let mut found = false;
    for record in output.stdout.split(|byte| *byte == 0).filter(|record| !record.is_empty()) {
        entries += 1;
        if entries > MAX_ENTRIES {
            bail!("repository exceeds the {MAX_ENTRIES} entry limit and does not look like a skills repository");
        }
        let text = String::from_utf8_lossy(record);
        let Some((meta, path)) = text.split_once('\t') else { continue };
        // Regular files only: symlinks (120000) and submodules (160000) never count.
        let regular = meta.starts_with("100644 blob") || meta.starts_with("100755 blob");
        if regular && path.rsplit('/').next() == Some(SKILL_FILE) {
            found = true;
        }
    }
    if !found {
        bail!(NOT_A_SKILL_REPOSITORY);
    }
    Ok(())
}

fn scan_repository(root: &Path, repository_name: &str) -> Result<(Vec<RepositorySkill>, Vec<String>)> {
    let mut skills = Vec::new();
    let mut warnings = Vec::new();
    let mut visited = 0usize;
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name().to_str() != Some(".git"));
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!("Entry skipped: {error}"));
                continue;
            }
        };
        visited += 1;
        if visited > MAX_ENTRIES {
            bail!("repository exceeds the {MAX_ENTRIES} entry discovery limit");
        }
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path()).display().to_string();
        if entry.file_type().is_symlink() {
            warnings.push(format!("Symbolic link not followed: {relative}"));
            continue;
        }
        if !entry.file_type().is_file() || entry.file_name().to_str() != Some(SKILL_FILE) {
            continue;
        }
        if entry.metadata().map(|metadata| metadata.len()).unwrap_or(u64::MAX) > MAX_SKILL_BYTES {
            warnings.push(format!("Skill file too large, skipped: {relative}"));
            continue;
        }
        let content = match fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => {
                warnings.push(format!("Skill file is not readable UTF-8, skipped: {relative}"));
                continue;
            }
        };
        let fields = parse_frontmatter(&content);
        let has_description = fields.get("description").map(|value| !value.trim().is_empty()).unwrap_or(false);
        if !has_description {
            warnings.push(format!("Not a valid skill (missing header or description), ignored: {relative}"));
            continue;
        }
        let folder = entry.path().parent().unwrap_or(root);
        let fallback = if folder == root {
            repository_name.to_string()
        } else {
            folder.file_name().and_then(|name| name.to_str()).unwrap_or("skill").to_string()
        };
        let name = fields
            .get("name")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback);
        if name.chars().any(char::is_control) {
            warnings.push(format!("Skill name contains control characters, skipped: {relative}"));
            continue;
        }
        skills.push(RepositorySkill {
            name,
            description: fields
                .get("description")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            relative_path: relative,
            absolute_path: entry.path().display().to_string(),
            conflict: false,
        });
    }
    skills.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok((skills, warnings))
}

fn describe(root: &Path, record: &Record) -> Result<SkillRepository> {
    let path = checkout_path(root, record);
    ensure_plain_dir(&root.join(&record.id))?;
    ensure_plain_dir(&path).context("repository checkout is missing")?;
    if !path.canonicalize()?.starts_with(root.canonicalize()?) {
        bail!("unsafe repository checkout path");
    }
    let (skills, warnings) = scan_repository(&path, &record.name)?;
    Ok(SkillRepository {
        id: record.id.clone(),
        name: record.name.clone(),
        url: record.url.clone(),
        enabled: record.enabled,
        auto_update: record.auto_update,
        revision: record.revision.clone(),
        absolute_path: path.display().to_string(),
        skills,
        warnings,
    })
}

fn unavailable(root: &Path, record: &Record, error: anyhow::Error) -> SkillRepository {
    SkillRepository {
        id: record.id.clone(),
        name: record.name.clone(),
        url: record.url.clone(),
        enabled: record.enabled,
        auto_update: record.auto_update,
        revision: record.revision.clone(),
        absolute_path: checkout_path(root, record).display().to_string(),
        skills: Vec::new(),
        warnings: vec![format!("Repository unavailable: {error:#}")],
    }
}

/// Every installed repository with its discovered skills. Read-only: no lock, no network.
pub(crate) fn catalog_in(root: &Path) -> Result<Vec<SkillRepository>> {
    let manifest = read_manifest(root)?;
    Ok(manifest
        .repositories
        .iter()
        .map(|record| describe(root, record).unwrap_or_else(|error| unavailable(root, record, error)))
        .collect())
}

/// Installed repositories, with conflicts computed against every visible skill (manual included).
pub fn list_skill_repositories(
    workspace_root: impl AsRef<Path>,
    settings: &SkillSettings,
) -> Result<Vec<SkillRepository>> {
    let root = storage_root()?;
    let mut repositories = catalog_in(&root)?;
    let conflicting: HashSet<String> = list_installed_skills_with(workspace_root.as_ref(), settings, Some(&root))
        .into_iter()
        .filter(|skill| skill.conflict)
        .map(|skill| skill.absolute_path)
        .collect();
    for repository in &mut repositories {
        for skill in &mut repository.skills {
            skill.conflict = conflicting.contains(&skill.absolute_path);
        }
    }
    Ok(repositories)
}

/// Clone into staging, validate, then publish. Any failure leaves the previous state untouched.
fn install_in(root: &Path, url: &str, existing: Option<&Record>, allow_local: bool) -> Result<SkillRepository> {
    let mut manifest = read_manifest(root)?;
    if existing.is_none() && manifest.repositories.iter().any(|record| same_url(&record.url, url)) {
        bail!("this repository is already installed");
    }
    let id = existing.map(|record| record.id.clone()).unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = existing
        .map(|record| record.name.clone())
        .unwrap_or_else(|| repository_name_from_url(url));
    let parent = root.join(&id);
    fs::create_dir_all(&parent)?;
    ensure_plain_dir(&parent)?;

    let generation = Uuid::new_v4().to_string();
    let staging = parent.join(format!(".staging-{generation}"));
    let target = parent.join(&generation);
    let log = parent.join(format!(".clone-{generation}.log"));

    let outcome = (|| -> Result<SkillRepository> {
        let revision = clone_into(url, &staging, &log, allow_local)?;
        let (skills, _) = scan_repository(&staging, &name)?;
        if skills.is_empty() {
            bail!(NOT_A_SKILL_REPOSITORY);
        }
        fs::rename(&staging, &target)?;
        let record = Record {
            id: id.clone(),
            name,
            url: url.to_string(),
            enabled: existing.map(|record| record.enabled).unwrap_or(true),
            auto_update: existing.map(|record| record.auto_update).unwrap_or(false),
            revision,
            checkout: generation.clone(),
        };
        let described = describe(root, &record)?;
        manifest.repositories.retain(|other| other.id != id);
        manifest.repositories.push(record);
        save_manifest(root, &manifest)?;
        Ok(described)
    })();

    let _ = fs::remove_file(&log);
    match outcome {
        Ok(described) => {
            if let Some(previous) = existing {
                // The previous generation is no longer referenced by the manifest.
                let _ = fs::remove_dir_all(parent.join(&previous.checkout));
            }
            Ok(described)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            let _ = fs::remove_dir_all(&target);
            if existing.is_none() {
                let _ = fs::remove_dir(&parent);
            }
            Err(error)
        }
    }
}

fn add_in(root: &Path, url: &str, allow_local: bool) -> Result<SkillRepository> {
    let url = normalized_url(url, allow_local)?;
    let _guard = lock();
    install_in(root, &url, None, allow_local)
}

fn find_record(root: &Path, id: &str) -> Result<Record> {
    read_manifest(root)?
        .repositories
        .into_iter()
        .find(|record| record.id == id)
        .context("unknown skill repository")
}

fn set_auto_update_in(root: &Path, id: &str, auto_update: bool) -> Result<()> {
    check_id(id)?;
    let _guard = lock();
    let mut manifest = read_manifest(root)?;
    manifest
        .repositories
        .iter_mut()
        .find(|record| record.id == id)
        .context("unknown skill repository")?
        .auto_update = auto_update;
    save_manifest(root, &manifest)
}

fn skill_names(repository: &SkillRepository) -> BTreeSet<String> {
    repository.skills.iter().map(|skill| skill.name.clone()).collect()
}

/// Caller holds the lock. Checks upstream read-only first; a fresh clone is made only when it moved.
fn update_locked(root: &Path, record: &Record, allow_local: bool) -> Result<SkillRepositoryUpdateReport> {
    let url = normalized_url(&record.url, allow_local)?;
    let remote = remote_head(&url, allow_local)?;
    if remote == record.revision {
        let repository = describe(root, record)?;
        return Ok(SkillRepositoryUpdateReport {
            previous_revision: record.revision.clone(),
            new_revision: record.revision.clone(),
            added_skills: Vec::new(),
            removed_skills: Vec::new(),
            updated: false,
            repository,
        });
    }
    let before = describe(root, record).map(|repository| skill_names(&repository)).unwrap_or_default();
    // Staged clone, validated, then published atomically; the previous generation is removed on success.
    let repository = install_in(root, &url, Some(record), allow_local)?;
    let after = skill_names(&repository);
    Ok(SkillRepositoryUpdateReport {
        previous_revision: record.revision.clone(),
        new_revision: repository.revision.clone(),
        added_skills: after.difference(&before).cloned().collect(),
        removed_skills: before.difference(&after).cloned().collect(),
        updated: repository.revision != record.revision,
        repository,
    })
}

fn update_in(root: &Path, id: &str, allow_local: bool) -> Result<SkillRepositoryUpdateReport> {
    check_id(id)?;
    let _guard = lock();
    let record = find_record(root, id)?;
    update_locked(root, &record, allow_local)
}

/// Updates every enabled repository (only those with `auto_update` when `only_auto`).
/// Sequential. Errors are collected per repository; the others still run.
fn update_all_in(root: &Path, only_auto: bool, allow_local: bool) -> Result<SkillRepositoryUpdateAllReport> {
    let _guard = lock();
    let mut outcome = SkillRepositoryUpdateAllReport::default();
    for record in read_manifest(root)?.repositories {
        if !record.enabled || (only_auto && !record.auto_update) {
            continue;
        }
        match update_locked(root, &record, allow_local) {
            Ok(report) if report.updated => outcome.reports.push(report),
            Ok(_) => {}
            Err(error) => outcome.errors.push(SkillRepositoryUpdateError {
                id: record.id.clone(),
                name: record.name.clone(),
                message: format!("{error:#}"),
            }),
        }
    }
    Ok(outcome)
}

fn set_enabled_in(root: &Path, id: &str, enabled: bool) -> Result<()> {
    check_id(id)?;
    let _guard = lock();
    let mut manifest = read_manifest(root)?;
    manifest
        .repositories
        .iter_mut()
        .find(|record| record.id == id)
        .context("unknown skill repository")?
        .enabled = enabled;
    save_manifest(root, &manifest)
}

fn remove_in(root: &Path, id: &str) -> Result<()> {
    check_id(id)?;
    let _guard = lock();
    let mut manifest = read_manifest(root)?;
    if !manifest.repositories.iter().any(|record| record.id == id) {
        bail!("unknown skill repository");
    }
    let original = root.join(id);
    ensure_plain_dir(&original)?;
    // Move out of the way first: if the manifest cannot be saved, the repository is restored.
    let trash = root.join(format!(".removed-{}", Uuid::new_v4()));
    fs::rename(&original, &trash)?;
    manifest.repositories.retain(|record| record.id != id);
    if let Err(error) = save_manifest(root, &manifest) {
        let _ = fs::rename(&trash, &original);
        return Err(error);
    }
    fs::remove_dir_all(&trash).context("repository removed from registry, but cleanup failed")
}

/// Read-only check: ask the remote for its HEAD revision without downloading anything.
fn check_upstream_in(root: &Path, id: &str, allow_local: bool) -> Result<UpstreamStatus> {
    check_id(id)?;
    let record = find_record(root, id)?;
    let url = normalized_url(&record.url, allow_local)?;
    let remote_revision = remote_head(&url, allow_local)?;
    Ok(UpstreamStatus {
        id: record.id,
        update_available: remote_revision != record.revision,
        installed_revision: record.revision,
        remote_revision,
    })
}

/// HEAD revision reported by the remote, read-only (`git ls-remote`).
fn remote_head(url: &str, allow_local: bool) -> Result<String> {
    let mut child = git_command(allow_local)
        .args(["ls-remote", "--", &url, "HEAD"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("unable to start Git; install Git to check repositories")?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() > Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Checking the remote repository timed out after 30 seconds");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let message: String = String::from_utf8_lossy(&output.stderr).chars().take(2000).collect();
        bail!("Unable to reach the remote repository: {}", message.trim());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().next())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .context("the remote repository did not report a revision")
}

/// Compare the installed revision with upstream. Never modifies anything.
pub fn check_skill_repository_upstream(id: &str) -> Result<UpstreamStatus> {
    check_upstream_in(&storage_root()?, id, false)
}

/// Clone a new repository from an HTTPS or SSH URL and register it (enabled).
pub fn add_skill_repository(url: &str) -> Result<SkillRepository> {
    add_in(&storage_root()?, url, false)
}

/// Manual update: checks upstream, then fresh clone of the same URL if it moved. Activation state kept.
pub fn update_skill_repository(id: &str) -> Result<SkillRepositoryUpdateReport> {
    update_in(&storage_root()?, id, false)
}

/// Manual "update all": every enabled repository, errors returned to the caller.
pub fn update_all_skill_repositories() -> Result<SkillRepositoryUpdateAllReport> {
    update_all_in(&storage_root()?, false, false)
}

/// Background run: enabled repositories with `auto_update` only. The caller drops the errors.
pub fn update_automatic_skill_repositories() -> Result<SkillRepositoryUpdateAllReport> {
    update_all_in(&storage_root()?, true, false)
}

pub fn set_skill_repository_enabled(id: &str, enabled: bool) -> Result<()> {
    set_enabled_in(&storage_root()?, id, enabled)
}

pub fn set_skill_repository_auto_update(id: &str, auto_update: bool) -> Result<()> {
    set_auto_update_in(&storage_root()?, id, auto_update)
}

/// Unregister and delete the repository folder. Manual skills are never touched.
pub fn remove_skill_repository(id: &str) -> Result<()> {
    remove_in(&storage_root()?, id)
}

#[cfg(test)]
#[path = "skill_repository_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "skill_repository_security_tests.rs"]
mod security_tests;

#[cfg(test)]
#[path = "skill_repository_update_tests.rs"]
mod update_tests;
