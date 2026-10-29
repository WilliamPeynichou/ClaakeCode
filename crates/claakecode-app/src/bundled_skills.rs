//! Skills shipped with the application.
//!
//! On launch the app copies each bundled skill into `~/.claakecode/skills/<folder>` exactly once.
//! The offer is recorded in a marker file, so a skill the user deletes or edits is never
//! reinstalled or overwritten, and a skill whose name already exists (in any home skills root)
//! is left alone. Nothing is executed: files are only copied.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::skill::scan_skill_root;

const SKILL_FILE: &str = "SKILL.md";
const MARKER_FILE: &str = ".bundled-skills.json";
const MAX_FILES_PER_SKILL: usize = 2_000;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    #[serde(default)]
    offered: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SeedReport {
    /// Folder names copied during this run.
    pub installed: Vec<String>,
    /// Folder names not copied because the user already has a skill with that folder or name.
    pub skipped_existing: Vec<String>,
}

/// Seed the bundled skills into the current user's home. Returns what happened.
pub fn seed_bundled_skills(bundled_root: &Path) -> Result<SeedReport> {
    let home = BaseDirs::new()
        .map(|base| base.home_dir().to_path_buf())
        .context("unable to locate home directory")?;
    seed_into(bundled_root, &home)
}

fn seed_into(bundled_root: &Path, home: &Path) -> Result<SeedReport> {
    let mut report = SeedReport::default();
    if !bundled_root.is_dir() {
        return Ok(report);
    }
    let target_root = home.join(".claakecode/skills");
    let marker_path = target_root.join(MARKER_FILE);
    let mut marker: Marker = fs::read_to_string(&marker_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let mut existing_names: HashSet<String> = [home.join(".agents/skills"), target_root.clone()]
        .iter()
        .flat_map(|root| scan_skill_root(root))
        .map(|skill| skill.name)
        .collect();

    let mut folders: Vec<PathBuf> = fs::read_dir(bundled_root)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join(SKILL_FILE).is_file())
        .collect();
    folders.sort();

    let mut changed = false;
    for source in folders {
        let Some(folder) = source.file_name().and_then(|name| name.to_str()).map(str::to_string) else {
            continue;
        };
        if folder.starts_with('_') || folder.starts_with('.') || marker.offered.contains(&folder) {
            continue;
        }
        let skill_name = scan_skill_root(bundled_root)
            .into_iter()
            .find(|skill| skill.path.parent() == Some(source.as_path()))
            .map(|skill| skill.name)
            .unwrap_or_else(|| folder.clone());

        let destination = target_root.join(&folder);
        marker.offered.push(folder.clone());
        changed = true;
        if destination.exists() || existing_names.contains(&skill_name) {
            report.skipped_existing.push(folder);
            continue;
        }
        fs::create_dir_all(&target_root)
            .with_context(|| format!("unable to create {}", target_root.display()))?;
        let staging = target_root.join(format!(".seed-{}-{}", folder, Uuid::new_v4()));
        let copied = copy_tree(&source, &staging).and_then(|_| {
            fs::rename(&staging, &destination).with_context(|| format!("unable to install {folder}"))
        });
        if let Err(error) = copied {
            let _ = fs::remove_dir_all(&staging);
            // Not recorded as offered: retry on the next launch.
            marker.offered.retain(|name| name != &folder);
            tracing::warn!(skill = %folder, error = %error, "bundled skill could not be installed");
            continue;
        }
        existing_names.insert(skill_name);
        report.installed.push(folder);
    }

    if changed {
        fs::create_dir_all(&target_root)?;
        let temporary = target_root.join(format!(".bundled-skills-{}.tmp", Uuid::new_v4()));
        fs::write(&temporary, serde_json::to_vec_pretty(&marker)?)?;
        fs::rename(&temporary, &marker_path)?;
    }
    Ok(report)
}

/// Copy regular files and directories only: symlinks and special files are ignored.
fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    let mut files = 0usize;
    for entry in walkdir::WalkDir::new(source).follow_links(false) {
        let entry = entry?;
        let relative = entry.path().strip_prefix(source)?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            files += 1;
            if files > MAX_FILES_PER_SKILL {
                anyhow::bail!("bundled skill has too many files");
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("claake-bundled-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_skill(root: &Path, folder: &str, name: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(dir.join("scripts")).unwrap();
        fs::write(dir.join(SKILL_FILE), format!("---\nname: {name}\ndescription: d\n---\nbody")).unwrap();
        fs::write(dir.join("scripts/run.py"), "print('x')").unwrap();
    }

    fn bundle(tmp: &Dir) -> PathBuf {
        let bundle = tmp.0.join("bundle");
        write_skill(&bundle, "alpha", "alpha");
        write_skill(&bundle, "beta", "Beta_Name");
        fs::create_dir_all(bundle.join("_licenses")).unwrap();
        fs::write(bundle.join("_licenses/L.txt"), "license").unwrap();
        fs::write(bundle.join("NOTICES.md"), "n").unwrap();
        bundle
    }

    #[test]
    fn installs_all_skills_with_their_resources_on_first_launch() {
        let tmp = Dir::new();
        let home = tmp.0.join("home");
        let report = seed_into(&bundle(&tmp), &home).unwrap();
        assert_eq!(report.installed, vec!["alpha", "beta"]);
        assert!(home.join(".claakecode/skills/alpha/scripts/run.py").is_file());
        assert!(!home.join(".claakecode/skills/_licenses").exists());
    }

    #[test]
    fn deleted_skill_is_not_reinstalled_and_edits_are_kept() {
        let tmp = Dir::new();
        let home = tmp.0.join("home");
        let bundle = bundle(&tmp);
        seed_into(&bundle, &home).unwrap();
        fs::remove_dir_all(home.join(".claakecode/skills/alpha")).unwrap();
        fs::write(home.join(".claakecode/skills/beta/SKILL.md"), "---\nname: Beta_Name\ndescription: mine\n---\nedited").unwrap();
        let report = seed_into(&bundle, &home).unwrap();
        assert!(report.installed.is_empty());
        assert!(!home.join(".claakecode/skills/alpha").exists());
        assert!(fs::read_to_string(home.join(".claakecode/skills/beta/SKILL.md")).unwrap().contains("edited"));
    }

    #[test]
    fn existing_skill_with_same_name_is_never_duplicated_or_overwritten() {
        let tmp = Dir::new();
        let home = tmp.0.join("home");
        write_skill(&home.join(".claakecode/skills"), "my-own-folder", "alpha");
        let report = seed_into(&bundle(&tmp), &home).unwrap();
        assert_eq!(report.installed, vec!["beta"]);
        assert_eq!(report.skipped_existing, vec!["alpha"]);
        assert!(!home.join(".claakecode/skills/alpha").exists());
    }

    #[test]
    fn missing_bundle_is_a_noop() {
        let tmp = Dir::new();
        let report = seed_into(&tmp.0.join("nope"), &tmp.0.join("home")).unwrap();
        assert_eq!(report, SeedReport::default());
    }

    #[test]
    #[cfg(unix)]
    fn symlinks_in_the_bundle_are_not_copied() {
        let tmp = Dir::new();
        let home = tmp.0.join("home");
        let bundle = bundle(&tmp);
        std::os::unix::fs::symlink("/etc/hosts", bundle.join("alpha/leak")).unwrap();
        seed_into(&bundle, &home).unwrap();
        assert!(!home.join(".claakecode/skills/alpha/leak").exists());
    }

    fn real_bundle() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/bundled-skills")
    }

    #[test]
    fn shipped_bundle_is_valid_and_free_of_personal_information() {
        let root = real_bundle();
        let skills = scan_skill_root(&root);
        assert!(skills.len() >= 30, "unexpectedly few bundled skills: {}", skills.len());
        let mut names = HashSet::new();
        for skill in &skills {
            assert!(names.insert(skill.name.clone()), "duplicate bundled skill name {}", skill.name);
            assert_ne!(skill.name, "add-models", "add-models is a private maintainer skill, never bundled");
            let content = fs::read_to_string(&skill.path).unwrap();
            let description = content
                .lines()
                .skip(1)
                .take_while(|line| line.trim() != "---")
                .find_map(|line| line.strip_prefix("description:"))
                .map(str::trim)
                .unwrap_or("");
            assert!(
                description.len() > 20 && description != ">" && description != ">-" && !description.contains("One-line trigger"),
                "bad description for {}: {description:?}",
                skill.name
            );
        }
        let forbidden = ["williampeynichou", "WilliamPeynichou", "Tiwis", ".claude/skills", "APPLE_ID", "TAURI_SIGNING"];
        for entry in walkdir::WalkDir::new(&root).into_iter().flatten().filter(|e| e.file_type().is_file()) {
            if let Ok(text) = fs::read_to_string(entry.path()) {
                for needle in forbidden {
                    assert!(!text.contains(needle), "{needle} found in {}", entry.path().display());
                }
            }
        }
        for private in ["RELEASE_CLAAKE", "CLAAKE_INFO", "upstream-sync", "REMOTION.md", "REMOTION_FOR_CLAAKE.md", "docx", "pdf", "pptx", "xlsx"] {
            assert!(!names.contains(private), "private skill {private} must not be bundled");
        }
        assert!(names.contains(crate::skill::PRIORITY_SKILL_NAME));
    }
}
