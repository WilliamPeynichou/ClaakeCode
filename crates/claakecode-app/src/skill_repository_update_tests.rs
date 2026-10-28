use std::{fs, path::{Path, PathBuf}, process::Command};

use super::*;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("claake-update-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_skill(dir: &Path, name: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(SKILL_FILE), format!("---\nname: {name}\ndescription: fixture {name}\n---\nBody\n")).unwrap();
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

fn source_repo(root: &Path, skill_name: &str) -> PathBuf {
    let repo = root.join("source-repo");
    write_skill(&repo.join("skills").join(skill_name), skill_name);
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    repo
}

fn head(repo: &Path) -> String {
    let output = Command::new("git").arg("-C").arg(repo).args(["rev-parse", "HEAD"]).output().unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn commit_new_skill(repo: &Path, skill_name: &str) -> String {
    write_skill(&repo.join("skills").join(skill_name), skill_name);
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", skill_name]);
    head(repo)
}

fn local_url(path: &Path) -> String {
    path.display().to_string()
}

/// Installed generations inside `<id>/`: staging leftovers or partial clones must not remain.
fn entries_of(root: &Path, id: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root.join(id))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn new_source_commit_is_detected_and_applied() {
    let tmp = Dir::new();
    let repo = source_repo(&tmp.0, "alpha");
    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();
    set_enabled_in(&root, &added.id, false).unwrap();
    set_auto_update_in(&root, &added.id, true).unwrap();

    let new_head = commit_new_skill(&repo, "beta");
    let report = update_in(&root, &added.id, true).unwrap();

    assert!(report.updated);
    assert_eq!(report.previous_revision, added.revision);
    assert_eq!(report.new_revision, new_head);
    assert_eq!(report.added_skills, vec!["beta".to_string()]);
    assert!(report.removed_skills.is_empty());
    assert_eq!(report.repository.skills.len(), 2);
    // Activation state and auto-update flag survive the swap.
    assert!(!report.repository.enabled);
    assert!(report.repository.auto_update);
    let catalog = catalog_in(&root).unwrap();
    assert_eq!(catalog[0].revision, new_head);
    assert_eq!(entries_of(&root, &added.id).len(), 1, "old generation removed");
}

#[test]
fn unreachable_source_keeps_previous_version_usable() {
    let tmp = Dir::new();
    let repo = source_repo(&tmp.0, "stable");
    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();
    set_auto_update_in(&root, &added.id, true).unwrap();
    fs::remove_dir_all(&repo).unwrap();

    assert!(update_in(&root, &added.id, true).is_err());
    assert!(check_upstream_in(&root, &added.id, true).is_err());
    let catalog = catalog_in(&root).unwrap();
    assert_eq!(catalog[0].revision, added.revision);
    assert_eq!(catalog[0].skills.len(), 1);
    assert!(Path::new(&catalog[0].absolute_path).join("skills/stable/SKILL.md").is_file());
    assert_eq!(entries_of(&root, &added.id).len(), 1, "no partial clone left behind");

    let outcome = update_all_in(&root, true, true).unwrap();
    assert!(outcome.reports.is_empty());
    assert_eq!(outcome.errors.len(), 1);
    assert_eq!(catalog_in(&root).unwrap()[0].revision, added.revision);
}

#[test]
fn new_version_without_skills_is_refused_and_previous_kept() {
    let tmp = Dir::new();
    let repo = source_repo(&tmp.0, "kept");
    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();

    fs::remove_dir_all(repo.join("skills")).unwrap();
    fs::write(repo.join("README.md"), "no skill anymore").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "drop skills"]);

    let error = update_in(&root, &added.id, true).unwrap_err();
    assert!(format!("{error:#}").contains("does not look like a skills repository"), "{error:#}");
    let catalog = catalog_in(&root).unwrap();
    assert_eq!(catalog[0].revision, added.revision);
    assert_eq!(catalog[0].skills.len(), 1);
    assert_eq!(entries_of(&root, &added.id).len(), 1, "staging cleaned up");
}

#[test]
fn disabled_or_manual_only_repositories_are_never_touched_by_automatic_update() {
    let tmp = Dir::new();
    let disabled = source_repo(&tmp.0, "off");
    let manual = {
        let path = tmp.0.join("manual-repo");
        write_skill(&path.join("skills").join("on"), "on");
        git(&path, &["init", "-q"]);
        git(&path, &["add", "."]);
        git(&path, &["commit", "-qm", "init"]);
        path
    };
    let root = tmp.0.join("store");
    let off = add_in(&root, &local_url(&disabled), true).unwrap();
    let on = add_in(&root, &local_url(&manual), true).unwrap();
    set_enabled_in(&root, &off.id, false).unwrap();
    // `on` is enabled but has auto_update left at its default (false).
    commit_new_skill(&disabled, "off-two");
    commit_new_skill(&manual, "on-two");

    let auto = update_all_in(&root, true, true).unwrap();
    assert!(auto.reports.is_empty());
    assert!(auto.errors.is_empty());
    let catalog = catalog_in(&root).unwrap();
    let off_after = catalog.iter().find(|r| r.id == off.id).unwrap();
    let on_after = catalog.iter().find(|r| r.id == on.id).unwrap();
    assert_eq!(off_after.revision, off.revision);
    assert_eq!(on_after.revision, on.revision);

    // The manual batch still refreshes enabled repositories, whatever their auto_update flag.
    let manual_run = update_all_in(&root, false, true).unwrap();
    assert_eq!(manual_run.reports.len(), 1);
    assert_eq!(manual_run.reports[0].repository.id, on.id);
    assert_eq!(catalog_in(&root).unwrap().iter().find(|r| r.id == off.id).unwrap().revision, off.revision);
}

#[test]
fn automatic_update_applies_only_to_opted_in_repositories() {
    let tmp = Dir::new();
    let repo = source_repo(&tmp.0, "opt");
    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();
    set_auto_update_in(&root, &added.id, true).unwrap();
    let new_head = commit_new_skill(&repo, "opt-two");

    let outcome = update_all_in(&root, true, true).unwrap();
    assert!(outcome.errors.is_empty());
    assert_eq!(outcome.reports.len(), 1);
    assert_eq!(outcome.reports[0].new_revision, new_head);
    assert!(outcome.reports[0].repository.auto_update);
    assert!(outcome.reports[0].repository.enabled);
}

#[test]
fn manifest_without_auto_update_field_loads_as_disabled() {
    let tmp = Dir::new();
    let repo = source_repo(&tmp.0, "legacy");
    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();

    let path = root.join(MANIFEST_FILE);
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for record in json["repositories"].as_array_mut().unwrap() {
        record.as_object_mut().unwrap().remove("auto_update");
    }
    fs::write(&path, serde_json::to_vec_pretty(&json).unwrap()).unwrap();

    let catalog = catalog_in(&root).unwrap();
    assert_eq!(catalog.len(), 1);
    assert!(!catalog[0].auto_update);
    assert!(catalog[0].enabled);
    assert_eq!(catalog[0].id, added.id);
    assert!(update_all_in(&root, true, true).unwrap().reports.is_empty());
}

#[test]
fn concurrent_updates_do_not_corrupt_and_clean_the_old_generation() {
    let tmp = Dir::new();
    let repo = source_repo(&tmp.0, "race");
    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();
    let new_head = commit_new_skill(&repo, "race-two");

    let results: Vec<Result<SkillRepositoryUpdateReport>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..2)
            .map(|_| scope.spawn(|| update_in(&root, &added.id, true)))
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap()).collect()
    });

    for result in &results {
        let report = result.as_ref().expect("both updates complete");
        assert_eq!(report.repository.revision, new_head);
    }
    // Exactly one of them moved the repository; the other saw the new revision and changed nothing.
    assert_eq!(results.iter().filter(|r| r.as_ref().unwrap().updated).count(), 1);
    let catalog = catalog_in(&root).unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].revision, new_head);
    assert_eq!(catalog[0].skills.len(), 2);
    assert_eq!(entries_of(&root, &added.id).len(), 1, "previous and partial generations removed");
}

/// Recipe on a local copy of the real ponytail fixture: automatic update after a new commit that
/// adds one skill and removes another (both copies), with the report, skills and conflicts checked.
#[test]
fn ponytail_auto_update_reports_added_and_removed_skills_without_conflict() {
    let tmp = Dir::new();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ponytail");
    let repo = tmp.0.join("ponytail");
    fs::create_dir_all(&repo).unwrap();
    let copy = Command::new("cp").arg("-R").arg(fixture.join(".")).arg(&repo).status().unwrap();
    assert!(copy.success());
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "ponytail"]);

    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();
    let mut names: Vec<&str> = added.skills.iter().map(|s| s.name.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"]);
    assert!(added.skills.iter().all(|s| !s.conflict));
    assert_eq!(added.warnings.iter().filter(|w| w.starts_with("doublon ignoré : ")).count(), 6);
    set_auto_update_in(&root, &added.id, true).unwrap();

    // Upstream change: one skill added, one removed from both copies.
    write_skill(&repo.join("skills").join("ponytail-new"), "ponytail-new");
    fs::remove_dir_all(repo.join("skills").join("ponytail-gain")).unwrap();
    fs::remove_dir_all(repo.join(".openclaw").join("skills").join("ponytail-gain")).unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "upstream change"]);
    let new_head = head(&repo);

    let outcome = update_all_in(&root, true, true).unwrap();
    assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
    assert_eq!(outcome.reports.len(), 1);
    let report = &outcome.reports[0];
    assert!(report.updated);
    assert_eq!(report.previous_revision, added.revision);
    assert_eq!(report.new_revision, new_head);
    assert_eq!(report.added_skills, vec!["ponytail-new".to_string()]);
    assert_eq!(report.removed_skills, vec!["ponytail-gain".to_string()]);
    assert!(report.repository.enabled && report.repository.auto_update);
    assert_eq!(report.repository.skills.len(), 6);
    assert!(report.repository.skills.iter().all(|s| !s.conflict));
    let ponytail = report.repository.skills.iter().find(|s| s.name == "ponytail").unwrap();
    assert!(ponytail.description.as_deref().unwrap_or_default().ends_with("Levels: lite, full (default), ultra."));
    assert_eq!(catalog_in(&root).unwrap()[0].revision, new_head);
    assert_eq!(entries_of(&root, &added.id).len(), 1, "old generation removed");
}
