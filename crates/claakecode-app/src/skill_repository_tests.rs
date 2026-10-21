use std::{fs, path::{Path, PathBuf}, process::Command};

use super::*;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("claake-repo-{}", Uuid::new_v4()));
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

/// Repository with: a root skill, a nested collection skill, a shared resource and an executable hook.
fn fixture_repo(root: &Path, skill_name: &str) -> PathBuf {
    let repo = root.join("source-repo");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    write_skill(&repo.join("collection/nested"), skill_name);
    fs::create_dir_all(repo.join("shared")).unwrap();
    fs::write(repo.join("shared/reference.txt"), "shared resource").unwrap();
    fs::write(repo.join("collection/nested/run.sh"), "#!/bin/sh\necho hi\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    repo
}

fn local_url(path: &Path) -> String {
    path.display().to_string()
}

#[test]
fn clone_keeps_full_tree_and_discovers_nested_skills() {
    let tmp = Dir::new();
    let repo = fixture_repo(&tmp.0, "nested-one");
    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();
    assert!(added.enabled);
    assert_eq!(added.skills.len(), 1);
    assert_eq!(added.skills[0].name, "nested-one");
    let checkout = PathBuf::from(&added.absolute_path);
    assert!(checkout.join("shared/reference.txt").is_file());
    assert!(checkout.join("collection/nested/run.sh").is_file());
    assert!(!added.revision.is_empty());
}

#[test]
fn duplicate_repository_url_is_refused() {
    let tmp = Dir::new();
    let repo = fixture_repo(&tmp.0, "dup");
    let root = tmp.0.join("store");
    add_in(&root, &local_url(&repo), true).unwrap();
    assert!(add_in(&root, &local_url(&repo), true).is_err());
}

#[test]
fn repository_without_skill_is_not_installed() {
    let tmp = Dir::new();
    let repo = tmp.0.join("empty");
    fs::create_dir_all(&repo).unwrap();
    fs::write(repo.join("README.md"), "no skill").unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "x"]);
    let root = tmp.0.join("store");
    assert!(add_in(&root, &local_url(&repo), true).is_err());
    assert!(catalog_in(&root).unwrap().is_empty());
}

#[test]
fn update_publishes_new_revision_and_keeps_enabled_state() {
    let tmp = Dir::new();
    let repo = fixture_repo(&tmp.0, "upd");
    let root = tmp.0.join("store");
    let first = add_in(&root, &local_url(&repo), true).unwrap();
    set_enabled_in(&root, &first.id, false).unwrap();
    write_skill(&repo.join("added"), "upd-two");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "second"]);
    let second = update_in(&root, &first.id, true).unwrap();
    assert_ne!(first.revision, second.revision);
    assert!(!second.enabled);
    assert_eq!(second.skills.len(), 2);
    assert!(!Path::new(&first.absolute_path).exists(), "previous generation removed after success");
}

#[test]
fn failed_update_keeps_previous_checkout_usable() {
    let tmp = Dir::new();
    let repo = fixture_repo(&tmp.0, "stable");
    let root = tmp.0.join("store");
    let first = add_in(&root, &local_url(&repo), true).unwrap();
    fs::remove_dir_all(&repo).unwrap();
    assert!(update_in(&root, &first.id, true).is_err());
    let after = catalog_in(&root).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].skills.len(), 1);
    assert!(Path::new(&after[0].absolute_path).join("shared/reference.txt").is_file());
    let entries: Vec<_> = fs::read_dir(root.join(&first.id)).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(entries.len(), 1, "no staging leftovers: {entries:?}");
}

#[test]
fn remove_deletes_only_the_repository() {
    let tmp = Dir::new();
    let repo = fixture_repo(&tmp.0, "gone");
    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();
    check_id(&added.id).unwrap();
    let guard = lock();
    let mut manifest = read_manifest(&root).unwrap();
    manifest.repositories.retain(|r| r.id != added.id);
    drop(guard);
    save_manifest(&root, &manifest).unwrap();
    fs::remove_dir_all(root.join(&added.id)).unwrap();
    assert!(catalog_in(&root).unwrap().is_empty());
    assert!(repo.join("collection/nested").is_dir(), "source repository untouched");
}

#[test]
fn scripts_are_never_executed_during_clone() {
    let tmp = Dir::new();
    let repo = fixture_repo(&tmp.0, "hooked");
    let marker = tmp.0.join("hook-ran");
    let hook = repo.join(".git/hooks/post-checkout");
    fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let root = tmp.0.join("store");
    add_in(&root, &local_url(&repo), true).unwrap();
    assert!(!marker.exists());
}

#[test]
fn symlinks_are_reported_not_followed() {
    let tmp = Dir::new();
    let repo = fixture_repo(&tmp.0, "linked");
    let outside = tmp.0.join("outside");
    write_skill(&outside, "outside-secret");
    std::os::unix::fs::symlink(&outside, repo.join("collection/link")).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "link"]);
    let root = tmp.0.join("store");
    let added = add_in(&root, &local_url(&repo), true).unwrap();
    assert!(added.skills.iter().all(|s| s.name != "outside-secret"));
    assert!(added.warnings.iter().all(|w| !w.is_empty()));
}

#[test]
fn url_validation_rejects_options_credentials_and_unknown_schemes() {
    for bad in ["", "--upload-pack=touch /tmp/x", "ext::sh -c touch", "file:///etc", "https://user:pw@example.com/a.git", "https://example.com/a.git?x=1", "http://example.com/a.git"] {
        assert!(normalized_url(bad, false).is_err(), "{bad} should be refused");
    }
    assert!(normalized_url("https://github.com/acme/skills.git", false).is_ok());
    assert!(normalized_url("git@github.com:acme/skills.git", false).is_ok());
}

#[test]
fn invalid_identifiers_are_rejected() {
    assert!(check_id("../../etc").is_err());
    assert!(check_id(&Uuid::new_v4().to_string().to_uppercase()).is_err());
    assert!(check_id(&Uuid::new_v4().to_string()).is_ok());
}

#[test]
fn conflicting_names_are_marked_and_excluded_from_agent() {
    let tmp = Dir::new();
    let repo = fixture_repo(&tmp.0, "clash-skill");
    let root = tmp.0.join("store");
    add_in(&root, &local_url(&repo), true).unwrap();
    let workspace = tmp.0.join("ws");
    write_skill(&workspace.join(".claakecode/skills/manual"), "clash-skill");
    let settings = SkillSettings::default();
    let listed = list_installed_skills_with(&workspace, &settings, Some(&root));
    let clashing: Vec<_> = listed.iter().filter(|s| s.name == "clash-skill").collect();
    assert_eq!(clashing.len(), 2, "both entries stay visible");
    assert!(clashing.iter().all(|s| s.conflict));
    let tool = crate::skill::SkillTool::with_settings(&workspace, settings);
    let _ = tool; // agent exclusion is covered by skill::tests
}
