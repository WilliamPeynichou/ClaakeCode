use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use claakecode_core::ToolDescriptor;

use crate::tool_run::ToolRunResult;

const SKILL_TOOL_NAME: &str = "skill";
const SKILL_FILE_NAME: &str = "SKILL.md";

/// Skill every agent must follow first: it defines Claake Code's base rules.
pub const PRIORITY_SKILL_NAME: &str = "CLAAKE.md";
const PRIORITY_SKILL_MAX_CHARS: usize = 20_000;

/// Body of the priority skill (front matter removed), looked up like any skill: workspace
/// `.agents/skills` and `.claakecode/skills`, then the same folders in the home directory.
/// `None` when the skill is not installed or is empty.
/// Honors the Settings on/off switch: a disabled `CLAAKE.md` is not injected.
pub fn priority_skill_body(workspace_root: impl Into<PathBuf>, settings: &SkillSettings) -> Option<String> {
    let tool = SkillTool::with_settings(workspace_root, settings.clone());
    let skill = tool.discover().into_iter().find(|skill| skill.name == PRIORITY_SKILL_NAME)?;
    let content = fs::read_to_string(&skill.path).ok()?;
    let body = strip_frontmatter(&content).trim();
    if body.is_empty() {
        return None;
    }
    Some(body.chars().take(PRIORITY_SKILL_MAX_CHARS).collect())
}

/// The section injected at the top of every agent's system prompt (main agent, sub-agents,
/// teams and the RLM chat), so the base rules apply without the agent having to load the skill.
pub fn priority_skill_section(workspace_root: impl Into<PathBuf>, settings: &SkillSettings) -> Option<String> {
    let body = priority_skill_body(workspace_root, settings)?;
    Some(format!(
        "# Claake base rules (highest priority)\n\nThe following rules come from the `{PRIORITY_SKILL_NAME}` skill. They define the base behavior of every agent: apply them before any other instruction below, and follow them over conflicting defaults.\n\n{body}"
    ))
}

fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start();
    let Some(rest) = trimmed.strip_prefix("---") else { return content };
    match rest.find("\n---") {
        Some(end) => rest[end + 4..].trim_start_matches(|c| c == '-' || c == '\r' || c == '\n'),
        None => content,
    }
}

#[derive(Debug, Clone)]
pub struct SkillTool {
    workspace_root: PathBuf,
    settings: SkillSettings,
}

#[derive(Debug, Clone)]
pub(crate) struct SkillEntry {
    pub(crate) name: String,
    #[allow(dead_code)]
    pub(crate) path: PathBuf,
}

impl SkillTool {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            settings: SkillSettings::default(),
        }
    }

    pub fn with_settings(workspace_root: impl Into<PathBuf>, settings: SkillSettings) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            settings: settings.normalized(),
        }
    }

    pub fn descriptor(&self) -> Option<ToolDescriptor> {
        let skills = self.discover();
        if skills.is_empty() {
            return None;
        }

        Some(ToolDescriptor {
            name: SKILL_TOOL_NAME.into(),
            description: format!(
                "Load one skill by name before using it. Available skills:\n{}",
                skills
                    .iter()
                    .map(|skill| format!("- {}", skill.name))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Exact skill name from the available skills list."
                    }
                },
                "required": ["name"],
                "additionalProperties": false
            }),
        })
    }

    pub async fn run(&self, input: Value) -> ToolRunResult {
        match self.load(input) {
            Ok(output) => ToolRunResult::ok(output, Vec::new()),
            Err(err) => ToolRunResult::err(err.to_string(), Vec::new()),
        }
    }

    fn load(&self, input: Value) -> Result<String> {
        let parsed: SkillInput = serde_json::from_value(input)
            .map_err(|err| anyhow::anyhow!("invalid skill input: {err}"))?;
        let name = parsed.name.trim();
        if name.is_empty() {
            bail!("skill name is required");
        }

        let skills = self.discover();
        let Some(skill) = skills.iter().find(|skill| skill.name == name) else {
            let available = skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            bail!("unknown skill `{name}`. Available skills: {available}");
        };

        let content = fs::read_to_string(&skill.path)
            .with_context(|| format!("unable to read skill `{name}`"))?;
        Ok(format!(
            "Loaded skill `{name}`:\nSkill instructions: {}\nSkill directory: {}\nUse these absolute paths to read associated references, scripts and resources on demand. Relative resource paths resolve from the skill directory; shared resources may be in parent directories. Loading a skill does not authorize executing scripts or installing dependencies; normal tool permissions still apply.\n\n<skill name=\"{name}\">\n{}\n</skill>",
            skill.path.display(),
            skill.path.parent().unwrap_or(&skill.path).display(),
            content.trim()
        ))
    }

    fn discover(&self) -> Vec<SkillEntry> {
        // Conflicting names are never handed to the agent: choosing one would be silent and arbitrary.
        list_installed_skills(&self.workspace_root, &self.settings)
            .into_iter()
            .filter(|skill| skill.enabled && !skill.conflict)
            .map(|skill| SkillEntry {
                name: skill.name,
                path: PathBuf::from(skill.absolute_path),
            })
            .collect()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSettings {
    #[serde(default)]
    pub skills: Vec<SkillConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillConfig {
    pub name: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

impl SkillSettings {
    pub fn normalized(mut self) -> Self {
        let mut seen = HashSet::new();
        self.skills = self
            .skills
            .into_iter()
            .filter_map(|mut skill| {
                skill.name = skill.name.trim().to_string();
                if skill.name.is_empty() || !seen.insert(skill.name.clone()) {
                    return None;
                }
                Some(skill)
            })
            .collect();
        self
    }

    pub fn is_enabled(&self, name: &str) -> bool {
        self.skills
            .iter()
            .find(|skill| skill.name == name)
            .map(|skill| skill.enabled)
            .unwrap_or(true)
    }
}

pub(crate) fn scan_skill_root(root: &Path) -> Vec<SkillEntry> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };

    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let skill_path = path.join(SKILL_FILE_NAME);
        if !skill_path.is_file() {
            continue;
        }

        let fallback_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill")
            .to_string();
        let name = fs::read_to_string(&skill_path)
            .ok()
            .and_then(|content| parse_skill_name(&content))
            .unwrap_or(fallback_name);

        skills.push(SkillEntry {
            name,
            path: skill_path,
        });
    }

    skills
}

fn parse_skill_name(content: &str) -> Option<String> {
    parse_frontmatter(content)
        .remove("name")
        .filter(|value| !value.is_empty())
}

/// Reads the `---` front matter of a skill with a real YAML parser (`>`, `|`, quotes, CRLF).
/// Only top-level scalars are kept, as one-line strings. No header gives an empty map.
/// Invalid YAML is logged and read leniently, line by line, so it never panics.
pub(crate) fn parse_frontmatter(content: &str) -> HashMap<String, String> {
    let text = content.trim_start_matches('\u{feff}').trim_start();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return HashMap::new();
    }
    let mut block: Vec<&str> = Vec::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        block.push(line);
    }
    if !closed {
        tracing::warn!("skill front matter has no closing '---' line; reading it leniently");
    }
    let yaml = block.join("\n");
    if yaml.trim().is_empty() {
        return HashMap::new();
    }
    match serde_yaml::from_str::<serde_yaml::Mapping>(&yaml) {
        Ok(mapping) => mapping
            .iter()
            .filter_map(|(key, value)| Some((yaml_scalar_text(key)?, yaml_scalar_text(value)?)))
            .collect(),
        Err(error) => {
            tracing::warn!(%error, "invalid YAML in skill front matter; using single-line fields");
            lenient_frontmatter_fields(&block)
        }
    }
}

/// Text of a top-level scalar, with whitespace (including folded line breaks) collapsed to one line.
fn yaml_scalar_text(value: &serde_yaml::Value) -> Option<String> {
    let text = match value {
        serde_yaml::Value::String(text) => text.clone(),
        serde_yaml::Value::Number(number) => number.to_string(),
        serde_yaml::Value::Bool(flag) => flag.to_string(),
        _ => return None,
    };
    Some(text.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Fallback for invalid YAML: only unindented `key: value` lines, so an indented line never
/// creates a key. Block indicators (`>`, `|`) are not values and are skipped.
fn lenient_frontmatter_fields(block: &[&str]) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    for line in block {
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = clean_yaml_string(value.trim());
        if key.is_empty() || key.contains(char::is_whitespace) || value.starts_with(['>', '|']) {
            continue;
        }
        fields.insert(key.to_string(), value.to_string());
    }
    fields
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSource {
    Workspace,
    Global,
    Repository,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: SkillSource,
    pub root_label: String,
    pub absolute_path: String,
    pub content: String,
    pub enabled: bool,
    pub repository_id: Option<String>,
    pub conflict: bool,
}

pub fn list_installed_skills(
    workspace_root: impl AsRef<Path>,
    settings: &SkillSettings,
) -> Vec<InstalledSkill> {
    list_installed_skills_with(workspace_root, settings, None)
}

/// `repository_root` overrides the managed repository storage (tests); `None` uses the default.
/// `conflict` is set on every enabled skill whose name is shared with another enabled skill.
pub(crate) fn list_installed_skills_with(
    workspace_root: impl AsRef<Path>,
    settings: &SkillSettings,
    repository_root: Option<&Path>,
) -> Vec<InstalledSkill> {
    let workspace_root = workspace_root.as_ref();
    let home_dir = BaseDirs::new().map(|base| base.home_dir().to_path_buf());

    let mut roots: Vec<(SkillSource, PathBuf)> = vec![
        (
            SkillSource::Workspace,
            workspace_root.join(".agents/skills"),
        ),
        (SkillSource::Workspace, workspace_root.join(".claakecode/skills")),
    ];
    if let Some(home) = home_dir.as_ref() {
        roots.push((SkillSource::Global, home.join(".agents/skills")));
        roots.push((SkillSource::Global, home.join(".claakecode/skills")));
    }

    // Manual skills keep their historical precedence: workspace before home, first name wins.
    let mut seen = HashSet::new();
    let mut skills = Vec::new();

    for (source, root) in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        let root_label = format_root_label(&root, workspace_root, home_dir.as_deref());

        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let skill_path = dir.join(SKILL_FILE_NAME);
            if !skill_path.is_file() {
                continue;
            }

            let Ok(content) = fs::read_to_string(&skill_path) else {
                continue;
            };
            let frontmatter = parse_frontmatter(&content);
            let fallback_name = dir
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("skill")
                .to_string();
            let name = frontmatter
                .get("name")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or(fallback_name);

            if !seen.insert(name.clone()) {
                continue;
            }

            let description = frontmatter
                .get("description")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let enabled = settings.is_enabled(&name);

            skills.push(InstalledSkill {
                name,
                description,
                source,
                root_label: root_label.clone(),
                absolute_path: skill_path.display().to_string(),
                content,
                enabled,
                repository_id: None,
                conflict: false,
            });
        }
    }

    let repositories = match repository_root {
        Some(root) => crate::skill_repository::catalog_in(root).unwrap_or_default(),
        None => crate::skill_repository::storage_root()
            .and_then(|root| crate::skill_repository::catalog_in(&root))
            .unwrap_or_default(),
    };
    for repository in repositories {
        for skill in repository.skills {
            let content = fs::read_to_string(&skill.absolute_path).unwrap_or_default();
            skills.push(InstalledSkill {
                name: skill.name,
                description: skill.description,
                source: SkillSource::Repository,
                root_label: repository.name.clone(),
                absolute_path: skill.absolute_path,
                content,
                enabled: repository.enabled,
                repository_id: Some(repository.id.clone()),
                conflict: false,
            });
        }
    }

    let mut counts = HashMap::<String, usize>::new();
    for skill in skills.iter().filter(|skill| skill.enabled) {
        *counts.entry(skill.name.clone()).or_default() += 1;
    }
    for skill in &mut skills {
        skill.conflict = skill.enabled && counts.get(&skill.name).copied().unwrap_or_default() > 1;
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    skills
}

/// Create a new empty skill under `~/.agents/skills/<name>/SKILL.md`.
///
/// Picks a unique folder name (`new-skill`, `new-skill-1`, …) so the user can
/// just click "Add" without having to think about naming. Returns the path of
/// the freshly written `SKILL.md` along with the resolved skill name.
pub fn create_installed_skill() -> Result<(String, PathBuf)> {
    let base = BaseDirs::new()
        .map(|base| base.home_dir().to_path_buf())
        .context("unable to locate home directory")?
        .join(".agents/skills");
    fs::create_dir_all(&base)
        .with_context(|| format!("unable to create skills folder {}", base.display()))?;

    let (name, folder) = pick_unique_skill_folder(&base);
    fs::create_dir_all(&folder)
        .with_context(|| format!("unable to create skill folder {}", folder.display()))?;

    let skill_path = folder.join(SKILL_FILE_NAME);
    if skill_path.exists() {
        bail!("skill file already exists at {}", skill_path.display());
    }
    let template = default_skill_template(&name);
    fs::write(&skill_path, template)
        .with_context(|| format!("unable to write {}", skill_path.display()))?;

    Ok((name, skill_path))
}

fn pick_unique_skill_folder(base: &Path) -> (String, PathBuf) {
    const STEM: &str = "new-skill";
    let candidate = base.join(STEM);
    if !candidate.exists() {
        return (STEM.to_string(), candidate);
    }
    let mut index = 1u32;
    loop {
        let name = format!("{STEM}-{index}");
        let candidate = base.join(&name);
        if !candidate.exists() {
            return (name, candidate);
        }
        index = index.saturating_add(1);
        if index == u32::MAX {
            // Extremely unlikely; fall back to a timestamp suffix.
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default();
            let name = format!("{STEM}-{stamp}");
            return (name.clone(), base.join(name));
        }
    }
}

fn default_skill_template(name: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: Describe what this skill helps with\n---\n\n# {name}\n\nWrite the instructions the agent should follow when this skill is enabled.\n"
    )
}

fn format_root_label(root: &Path, workspace_root: &Path, home_dir: Option<&Path>) -> String {
    if let Ok(rel) = root.strip_prefix(workspace_root) {
        return rel.display().to_string();
    }
    if let Some(home) = home_dir {
        if let Ok(rel) = root.strip_prefix(home) {
            return format!("~/{}", rel.display());
        }
    }
    root.display().to_string()
}

fn clean_yaml_string(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct SkillInput {
    name: String,
}

#[cfg(test)]
mod priority_tests {
    #[test]
    fn strips_frontmatter_for_the_priority_body() {
        assert_eq!(super::strip_frontmatter("---\nname: CLAAKE.md\ndescription: x\n---\n\nRule one."), "Rule one.");
        assert_eq!(super::strip_frontmatter("No front matter"), "No front matter");
    }

    #[test]
    fn priority_skill_is_read_from_the_workspace_skill_folder() {
        let root = std::env::temp_dir().join(format!("cc-prio-{}", uuid::Uuid::new_v4()));
        let dir = root.join(".agents/skills/base");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: CLAAKE.md\n---\nAlways answer in French.").unwrap();
        let section = super::priority_skill_section(&root, &super::SkillSettings::default()).unwrap();
        assert!(section.starts_with("# Claake base rules (highest priority)"));
        assert!(section.contains("Always answer in French."));
        assert!(!section.contains("name: CLAAKE.md"));
        let off = super::SkillSettings {
            skills: vec![super::SkillConfig { name: "CLAAKE.md".into(), enabled: false }],
        };
        assert!(super::priority_skill_section(&root, &off).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod frontmatter_tests {
    use super::parse_frontmatter;

    #[test]
    fn folded_description_is_read_in_full_and_collapsed_to_one_line() {
        let content = "---\nname: ponytail\ndescription: >\n  First part of the text\n  and the second part.\n---\nBody";
        let fields = parse_frontmatter(content);
        assert_eq!(fields.get("description").map(String::as_str), Some("First part of the text and the second part."));
        assert!(!fields.get("description").unwrap().starts_with('>'));
    }

    #[test]
    fn literal_description_keeps_all_lines() {
        let content = "---\nname: lit\ndescription: |\n  Line one\n  Line two\n---\n";
        let fields = parse_frontmatter(content);
        assert_eq!(fields.get("description").map(String::as_str), Some("Line one Line two"));
        assert_eq!(fields.get("name").map(String::as_str), Some("lit"));
    }

    #[test]
    fn indented_line_with_colon_never_overrides_name_or_creates_a_key() {
        let content = "---\nname: real-name\ndescription: >\n  name: hijacked\n  extra: value\n---\n";
        let fields = parse_frontmatter(content);
        assert_eq!(fields.get("name").map(String::as_str), Some("real-name"));
        assert!(!fields.contains_key("extra"));
        assert_eq!(fields.get("description").map(String::as_str), Some("name: hijacked extra: value"));
    }

    #[test]
    fn quoted_and_plain_values_are_unwrapped() {
        let content = "---\nname: \"quoted name\"\ndescription: 'single quoted'\n---\n";
        let fields = parse_frontmatter(content);
        assert_eq!(fields.get("name").map(String::as_str), Some("quoted name"));
        assert_eq!(fields.get("description").map(String::as_str), Some("single quoted"));
    }

    #[test]
    fn invalid_yaml_does_not_panic_and_keeps_single_line_fields() {
        // Unquoted colon inside a value and a broken indentation: not valid YAML.
        let content = "---\nname: broken\ndescription: Use this: when needed\n  - [unclosed\n---\nBody";
        let fields = parse_frontmatter(content);
        assert_eq!(fields.get("name").map(String::as_str), Some("broken"));
        assert_eq!(fields.get("description").map(String::as_str), Some("Use this: when needed"));
    }

    #[test]
    fn old_single_line_format_is_still_read() {
        let content = "---\nname: old-style\ndescription: A one-line description\n---\nBody";
        let fields = parse_frontmatter(content);
        assert_eq!(fields.get("name").map(String::as_str), Some("old-style"));
        assert_eq!(fields.get("description").map(String::as_str), Some("A one-line description"));
    }

    #[test]
    fn crlf_line_endings_are_handled() {
        let content = "---\r\nname: crlf\r\ndescription: >\r\n  Windows text\r\n  continues\r\n---\r\nBody\r\n";
        let fields = parse_frontmatter(content);
        assert_eq!(fields.get("name").map(String::as_str), Some("crlf"));
        assert_eq!(fields.get("description").map(String::as_str), Some("Windows text continues"));
    }

    #[test]
    fn missing_header_gives_no_fields() {
        assert!(parse_frontmatter("# Just a body\ndescription: nope").is_empty());
        assert!(parse_frontmatter("").is_empty());
    }

    #[test]
    fn non_string_values_are_converted() {
        let content = "---\nname: 2024\ndescription: true\n---\n";
        let fields = parse_frontmatter(content);
        assert_eq!(fields.get("name").map(String::as_str), Some("2024"));
        assert_eq!(fields.get("description").map(String::as_str), Some("true"));
    }

    #[test]
    fn claake_md_priority_skill_frontmatter_is_read() {
        let content = "---\nname: CLAAKE.md\ndescription: Base rules for every agent\n---\n\n# Rules";
        let fields = parse_frontmatter(content);
        assert_eq!(fields.get("name").map(String::as_str), Some("CLAAKE.md"));
        assert_eq!(fields.get("description").map(String::as_str), Some("Base rules for every agent"));
    }
}

#[cfg(test)]
mod ponytail_fixture_tests {
    use super::parse_frontmatter;

    // Real SKILL.md files of https://github.com/DietrichGebert/ponytail at 09c434ab73ca43761c5d8b0c5d341926c2fba710.
    const SKILL_NAMES: [&str; 6] = [
        "ponytail",
        "ponytail-audit",
        "ponytail-debt",
        "ponytail-gain",
        "ponytail-help",
        "ponytail-review",
    ];

    fn long_copy(name: &str) -> &'static str {
        match name {
            "ponytail" => include_str!("../tests/fixtures/ponytail/skills/ponytail/SKILL.md"),
            "ponytail-audit" => include_str!("../tests/fixtures/ponytail/skills/ponytail-audit/SKILL.md"),
            "ponytail-debt" => include_str!("../tests/fixtures/ponytail/skills/ponytail-debt/SKILL.md"),
            "ponytail-gain" => include_str!("../tests/fixtures/ponytail/skills/ponytail-gain/SKILL.md"),
            "ponytail-help" => include_str!("../tests/fixtures/ponytail/skills/ponytail-help/SKILL.md"),
            _ => include_str!("../tests/fixtures/ponytail/skills/ponytail-review/SKILL.md"),
        }
    }

    fn short_copy(name: &str) -> &'static str {
        match name {
            "ponytail" => include_str!("../tests/fixtures/ponytail/.openclaw/skills/ponytail/SKILL.md"),
            "ponytail-audit" => include_str!("../tests/fixtures/ponytail/.openclaw/skills/ponytail-audit/SKILL.md"),
            "ponytail-debt" => include_str!("../tests/fixtures/ponytail/.openclaw/skills/ponytail-debt/SKILL.md"),
            "ponytail-gain" => include_str!("../tests/fixtures/ponytail/.openclaw/skills/ponytail-gain/SKILL.md"),
            "ponytail-help" => include_str!("../tests/fixtures/ponytail/.openclaw/skills/ponytail-help/SKILL.md"),
            _ => include_str!("../tests/fixtures/ponytail/.openclaw/skills/ponytail-review/SKILL.md"),
        }
    }

    #[test]
    fn every_real_ponytail_skill_reads_name_and_full_description() {
        for name in SKILL_NAMES {
            let fields = parse_frontmatter(long_copy(name));
            assert_eq!(fields.get("name").map(String::as_str), Some(name), "name of {name}");
            let description = fields.get("description").unwrap_or_else(|| panic!("description of {name}"));
            assert!(!description.starts_with('>'), "{name} must not keep the folded indicator");
            assert!(!description.contains('\n'), "{name} description must be one line");
            assert!(description.len() > 80, "{name} description must be the full text");
        }
    }

    #[test]
    fn ponytail_description_keeps_its_last_words() {
        let fields = parse_frontmatter(long_copy("ponytail"));
        let description = fields.get("description").unwrap();
        assert!(description.starts_with("Lazy senior dev mode: the smallest change"));
        assert!(description.ends_with("Levels: lite, full (default), ultra."));
        assert_eq!(fields.get("argument-hint").map(String::as_str), Some("[lite|full|ultra|off]"));
        assert_eq!(fields.get("license").map(String::as_str), Some("MIT"));
    }

    #[test]
    fn indented_shortcut_colon_and_slash_command_stay_inside_description() {
        let fields = parse_frontmatter(long_copy("ponytail-debt"));
        let description = fields.get("description").unwrap();
        assert!(description.contains("`shortcut:` comment"));
        assert!(!fields.contains_key("shortcut"));
        assert_eq!(fields.get("name").map(String::as_str), Some("ponytail-debt"));

        let audit = parse_frontmatter(long_copy("ponytail-audit"));
        assert!(audit.get("description").unwrap().ends_with("/ponytail-audit."));
    }

    #[test]
    fn short_copy_reads_quoted_one_line_description_and_extra_keys() {
        for name in SKILL_NAMES {
            let fields = parse_frontmatter(short_copy(name));
            assert_eq!(fields.get("name").map(String::as_str), Some(name));
            let description = fields.get("description").unwrap();
            assert!(!description.starts_with('"'), "{name} quotes must be removed");
            assert!(!description.contains('\n'));
            assert_eq!(fields.get("license").map(String::as_str), Some("MIT"));
            assert_eq!(
                fields.get("homepage").map(String::as_str),
                Some("https://github.com/DietrichGebert/ponytail"),
            );
        }
    }

    #[test]
    fn long_copy_description_is_longer_than_short_copy() {
        for name in SKILL_NAMES {
            let long = parse_frontmatter(long_copy(name)).remove("description").unwrap();
            let short = parse_frontmatter(short_copy(name)).remove("description").unwrap();
            assert!(long.len() > short.len(), "{name}: the skills/ copy holds the full text");
        }
    }
}

/// Persona of the companion character. Tone only: tools, rules and language stay unchanged.
pub const CLAAKY_PERSONA: &str = "# Claaky\n\nIn this app you are Claaky, the friendly companion of Claake Code. The user talks to you directly and you are the one who writes the code. Keep every rule, tool and language choice above unchanged. Be warm, direct and concise: no role-play, no catchphrases, no filler, and never let the persona make an answer longer or less accurate.";
