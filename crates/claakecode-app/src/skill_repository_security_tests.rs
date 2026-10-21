//! Validation tests: single repository switch propagation, reactivation without re-clone,
//! and refusal of unsafe checkout paths. Owned by the validation pass.
use std::{fs, path::{Path, PathBuf}, process::Command};

use super::*;
use crate::skill::SkillConfig;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("claake-repo-sec-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
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

fn repo_with_skill(root: &Path, name: &str) -> PathBuf {
    let repo = root.join("src-repo");
    let skill = repo.join("collection/nested");
    fs::create_dir_all(&skill).unwrap();
    fs::write(skill.join(SKILL_FILE), format!("---\nname: {name}\ndescription: sec {name}\n---\nBody\n")).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    repo
}

#[test]
fn single_switch_disables_and_reenables_without_reclone() {
    let tmp = Dir::new();
    let repo = repo_with_skill(&tmp.0, "switch-skill");
    let root = tmp.0.join("store");
    let added = add_in(&root, &repo.display().to_string(), true).unwrap();
    let workspace = tmp.0.join("ws");
    fs::create_dir_all(&workspace).unwrap();
    let settings = SkillSettings::default();

    let on = list_installed_skills_with(&workspace, &settings, Some(&root));
    assert!(on.iter().any(|s| s.name == "switch-skill" && s.enabled && s.repository_id.as_deref() == Some(added.id.as_str())));

    set_enabled_in(&root, &added.id, false).unwrap();
    let off = list_installed_skills_with(&workspace, &settings, Some(&root));
    assert!(off.iter().filter(|s| s.name == "switch-skill").all(|s| !s.enabled));

    // Reactivation must reuse the existing checkout: same revision, same path, no clone.
    set_enabled_in(&root, &added.id, true).unwrap();
    let back = catalog_in(&root).unwrap();
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].revision, added.revision);
    assert_eq!(back[0].absolute_path, added.absolute_path);
    let again = list_installed_skills_with(&workspace, &settings, Some(&root));
    assert!(again.iter().any(|s| s.name == "switch-skill" && s.enabled));
}

#[test]
fn no_individual_switch_is_exposed_for_repository_skills() {
    // Repository skills carry the repository's enabled flag only; there is no per-skill key.
    let tmp = Dir::new();
    let repo = repo_with_skill(&tmp.0, "solo-skill");
    let root = tmp.0.join("store");
    let added = add_in(&root, &repo.display().to_string(), true).unwrap();
    let workspace = tmp.0.join("ws");
    fs::create_dir_all(&workspace).unwrap();
    let mut settings = SkillSettings::default();
    settings.skills.push(SkillConfig { name: "solo-skill".into(), enabled: false });
    let listed = list_installed_skills_with(&workspace, &settings, Some(&root));
    let skill = listed.iter().find(|s| s.name == "solo-skill").unwrap();
    assert_eq!(skill.repository_id.as_deref(), Some(added.id.as_str()));
    assert!(skill.enabled, "a per-skill manual setting must not affect repository skills");
}

#[test]
fn checkout_directory_replaced_by_symlink_is_refused() {
    let tmp = Dir::new();
    let repo = repo_with_skill(&tmp.0, "link-guard");
    let root = tmp.0.join("store");
    let added = add_in(&root, &repo.display().to_string(), true).unwrap();
    let outside = tmp.0.join("outside");
    fs::create_dir_all(&outside).unwrap();
    let checkout = PathBuf::from(&added.absolute_path);
    fs::rename(&checkout, tmp.0.join("moved")).unwrap();
    std::os::unix::fs::symlink(&outside, &checkout).unwrap();
    let catalog = catalog_in(&root).unwrap();
    assert!(catalog[0].skills.is_empty(), "symlinked checkout must not be scanned");
    assert!(!catalog[0].warnings.is_empty(), "the failure must be visible");
}

#[test]
fn local_file_urls_are_refused_for_users() {
    assert!(normalized_url("file:///etc", false).is_err());
    assert!(normalized_url("/tmp/some-repo", false).is_err());
}

fn plain_repo(root: &Path, files: &[(&str, &str)]) -> PathBuf {
    let repo = root.join("plain-repo");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    for (path, content) in files {
        let file = repo.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, content).unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    repo
}

fn store_is_empty(store: &Path) -> bool {
    read_manifest(store).map(|m| m.repositories.is_empty()).unwrap_or(true)
        && fs::read_dir(store)
            .map(|entries| entries.flatten().all(|e| e.file_name() == "repositories.json"))
            .unwrap_or(true)
}

#[test]
fn non_skill_repository_is_refused_before_checkout_and_leaves_no_trace() {
    let tmp = Dir::new();
    let repo = plain_repo(&tmp.0, &[("README.md", "# app"), ("src/main.rs", "fn main() {}")]);
    let store = tmp.0.join("store");
    let error = add_in(&store, &repo.display().to_string(), true).unwrap_err().to_string();
    assert!(error.contains("does not look like a skills repository"), "{error}");
    assert!(store_is_empty(&store));
}

#[test]
fn skill_file_without_valid_header_does_not_make_a_skill_repository() {
    let tmp = Dir::new();
    let repo = plain_repo(&tmp.0, &[("docs/SKILL.md", "just notes, no front matter")]);
    let store = tmp.0.join("store");
    let error = add_in(&store, &repo.display().to_string(), true).unwrap_err().to_string();
    assert!(error.contains("does not look like a skills repository"), "{error}");
    assert!(store_is_empty(&store));
}

#[test]
fn skill_file_with_header_but_no_description_is_refused() {
    let tmp = Dir::new();
    let repo = plain_repo(&tmp.0, &[("SKILL.md", "---\nname: lonely\n---\nbody")]);
    let store = tmp.0.join("store");
    assert!(add_in(&store, &repo.display().to_string(), true).is_err());
    assert!(store_is_empty(&store));
}

#[test]
fn upstream_check_detects_new_commits_without_modifying_anything() {
    let tmp = Dir::new();
    let repo = repo_with_skill(&tmp.0, "up");
    let store = tmp.0.join("store");
    let added = add_in(&store, &repo.display().to_string(), true).unwrap();
    let status = check_upstream_in(&store, &added.id, true).unwrap();
    assert!(!status.update_available);

    fs::write(repo.join("NEW.txt"), "new").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "second"]);
    let status = check_upstream_in(&store, &added.id, true).unwrap();
    assert!(status.update_available);
    assert_eq!(status.installed_revision, added.revision);
    // Checking never installs the new revision.
    let after = catalog_in(&store).unwrap();
    assert_eq!(after[0].revision, added.revision);
}

#[test]
fn upstream_check_rejects_unknown_repository() {
    let tmp = Dir::new();
    assert!(check_upstream_in(&tmp.0.join("store"), "00000000-0000-0000-0000-000000000000", true).is_err());
}
