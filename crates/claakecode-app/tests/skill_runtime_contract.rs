//! Public runtime contracts shared by desktop, subagents and teams.
use std::{fs, path::{Path, PathBuf}};

use claakecode_app::{list_installed_skills, ReadTool, SkillConfig, SkillSettings, SkillTool};
use serde_json::json;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("claake-skill-runtime-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn skill(&self, relative: &str, name: &str) -> PathBuf {
        let dir = self.0.join(relative);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: Runtime fixture\n---\n\nRead ../../shared/reference.txt when needed.\n")).unwrap();
        dir
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}
fn descriptor_has(tool: &SkillTool, name: &str) -> bool {
    tool.descriptor().is_some_and(|descriptor| descriptor.description.lines().any(|line| line == format!("- {name}")))
}

#[tokio::test]
async fn manual_skill_listing_activation_and_loading_remain_compatible() {
    let fixture = Fixture::new();
    let name = format!("manual-contract-{}", uuid::Uuid::new_v4());
    let dir = fixture.skill(".claakecode/skills/manual", &name);
    let settings = SkillSettings::default();
    let listed = list_installed_skills(&fixture.0, &settings);
    let skill = listed.iter().find(|skill| skill.name == name).unwrap();
    assert_eq!(skill.description.as_deref(), Some("Runtime fixture"));
    assert!(skill.enabled);
    assert_eq!(Path::new(&skill.absolute_path), dir.join("SKILL.md"));
    let enabled = SkillTool::with_settings(&fixture.0, settings);
    assert!(descriptor_has(&enabled, &name));
    let loaded = enabled.run(json!({ "name": name })).await;
    assert!(!loaded.is_error, "{}", loaded.content);
    assert!(loaded.content.contains("Read ../../shared/reference.txt"));

    let disabled = SkillTool::with_settings(&fixture.0, SkillSettings {
        skills: vec![SkillConfig { name: name.clone(), enabled: false }],
    });
    assert!(!descriptor_has(&disabled, &name));
    let denied = disabled.run(json!({ "name": name })).await;
    assert!(denied.is_error);
}

#[tokio::test]
async fn resources_outside_workspace_are_read_on_demand_without_running_scripts() {
    let workspace = Fixture::new();
    let repository = Fixture::new();
    let skill_dir = repository.skill("collection/nested", "resource-contract");
    let shared = repository.0.join("shared");
    fs::create_dir_all(&shared).unwrap();
    fs::write(shared.join("reference.txt"), "shared fixture resource\nsecond line\n").unwrap();
    // Installation preserves executables as files: reading resources must never run them.
    let marker = repository.0.join("executed-marker");
    fs::write(skill_dir.join("setup.sh"), format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    let absolute_resource = skill_dir.join("../../shared/reference.txt");
    let result = ReadTool::new(&workspace.0).run(json!({
        "path": absolute_resource,
        "ranges": [{ "offset": 0, "limit": 2 }]
    })).await;
    assert!(!result.is_error, "{}", result.content);
    assert!(result.content.contains("shared fixture resource"));
    assert!(result.content.contains("second line"));
    assert!(!marker.exists());
}

#[tokio::test]
async fn unknown_skill_cannot_be_loaded_by_passing_a_path() {
    let fixture = Fixture::new();
    let dir = fixture.skill(".agents/skills/manual", "path-contract");
    let tool = SkillTool::new(&fixture.0);
    let result = tool.run(json!({ "name": dir.join("SKILL.md") })).await;
    assert!(result.is_error);
    assert!(result.content.contains("unknown skill"));
}
