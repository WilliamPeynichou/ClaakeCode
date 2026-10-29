//! Remote model catalog (`models.json`). Lets us add/fix/hide models without a release.
//! Process-global on purpose: provider crates read it from their `capabilities()`.
//! shortcut: global state instead of plumbing a handle into every provider, upgrade if tests need isolation.

use std::collections::HashSet;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::{EffortMode, ModelCapabilities, ModelRef};

/// Highest `format` this build can read. Newer catalogs are rejected (cache is kept).
pub const CATALOG_FORMAT: u32 = 1;
pub const CATALOG_PROVIDERS: &[&str] = &["anthropic", "openai", "google", "xai", "kimi"];
// Only levels preserved by both the UI and the provider request encoder are accepted.
fn thinking_levels(provider: &str, id: &str) -> &'static [&'static str] {
    match provider {
        "anthropic" => &["off", "low", "medium", "high", "xhigh", "max"],
        "openai" if id == "gpt-5.3-codex-spark" => &["low", "medium", "high", "xhigh", "max"],
        "openai" => &["off", "low", "medium", "high", "xhigh", "max"],
        "google" if id.contains("-pro") => &["low", "medium", "high"],
        "google" => &["minimal", "low", "medium", "high"],
        "xai" => &["off", "low", "medium", "high", "xhigh"],
        "kimi" => &["off", "high"],
        _ => &[],
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub provider: String,
    pub id: String,
    pub label: String,
    pub context_window: u32,
    pub preferred_window: u32,
    pub max_output: u32,
    pub thinking: Vec<String>,
    pub default_thinking: String,
    #[serde(default)]
    pub supports_fast: bool,
    #[serde(default = "yes")]
    pub supports_images: bool,
    /// Anthropic opt-in 1M context beta windows.
    #[serde(default, rename = "contextWindow1m")]
    pub context_window_1m: Option<u32>,
    #[serde(default, rename = "preferredWindow1m")]
    pub preferred_window_1m: Option<u32>,
    #[serde(default)]
    pub hidden: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Catalog {
    pub format: u32,
    pub models: Vec<CatalogModel>,
}

/// Parse + validate. Any problem rejects the whole catalog.
pub fn parse(json: &str) -> Result<Catalog, String> {
    let catalog: Catalog = serde_json::from_str(json).map_err(|e| format!("invalid json: {e}"))?;
    if catalog.format > CATALOG_FORMAT {
        return Err(format!("unsupported format {}", catalog.format));
    }
    let mut seen = HashSet::new();
    for m in &catalog.models {
        let name = format!("{}:{}", m.provider, m.id);
        if !CATALOG_PROVIDERS.contains(&m.provider.as_str()) {
            return Err(format!("{name}: unknown provider"));
        }
        if m.id.trim().is_empty() || m.label.trim().is_empty() {
            return Err(format!("{name}: empty id or label"));
        }
        if !seen.insert(name.clone()) {
            return Err(format!("{name}: duplicate"));
        }
        if m.context_window == 0 || m.max_output == 0 || m.preferred_window > m.context_window {
            return Err(format!("{name}: bad context/output windows"));
        }
        let allowed = thinking_levels(&m.provider, &m.id);
        if m.thinking.is_empty() || m.thinking.iter().any(|t| !allowed.contains(&t.as_str()))
        {
            return Err(format!("{name}: thinking levels unsupported by this provider adapter"));
        }
        if !m.thinking.contains(&m.default_thinking) {
            return Err(format!("{name}: defaultThinking not in thinking"));
        }
        match (m.context_window_1m, m.preferred_window_1m) {
            (None, None) => {}
            (Some(c), Some(p)) if p <= c && c > 0 => {}
            _ => return Err(format!("{name}: bad 1m windows")),
        }
    }
    Ok(catalog)
}

const EMBEDDED_JSON: &str = include_str!("../../../models.json");

/// Catalog shipped inside the binary: the offline / first-launch baseline.
fn embedded() -> &'static Catalog {
    static EMBEDDED: OnceLock<Catalog> = OnceLock::new();
    EMBEDDED.get_or_init(|| parse(EMBEDDED_JSON).expect("embedded models.json must be valid"))
}

/// Remote wins on id, remote order first, then embedded models the remote does not mention.
/// Hidden models stay in the list (engine lookups); UIs filter them out.
pub fn merge(remote: &Catalog, embedded: &Catalog) -> Catalog {
    let mut models = remote.models.clone();
    models.extend(
        embedded
            .models
            .iter()
            .filter(|e| !remote.models.iter().any(|r| r.provider == e.provider && r.id == e.id))
            .cloned(),
    );
    Catalog { format: CATALOG_FORMAT, models }
}

static REMOTE: RwLock<Option<Catalog>> = RwLock::new(None);

/// Activate a validated remote catalog (`None` = back to embedded only).
pub fn set(remote: Option<Catalog>) {
    if let Ok(mut guard) = REMOTE.write() {
        *guard = remote;
    }
}

/// Single source of truth for every consumer (engine, desktop UI, phone UI).
pub fn current() -> Catalog {
    match REMOTE.read().ok().and_then(|g| g.clone()) {
        Some(remote) => merge(&remote, embedded()),
        None => embedded().clone(),
    }
}

/// Hidden models are still returned: existing conversations must keep working.
pub fn lookup(provider: &str, id: &str) -> Option<CatalogModel> {
    current().models.into_iter().find(|m| m.provider == provider && m.id == id)
}

pub fn capabilities(model: &ModelRef, effort_mode: EffortMode) -> Option<ModelCapabilities> {
    let m = lookup(&model.provider, &model.name)?;
    let beta = match (model.use_1m_context_enabled(), m.context_window_1m, m.preferred_window_1m) {
        (true, Some(c), Some(p)) => Some((c, p)),
        _ => None,
    };
    let (context_window, preferred_window) = beta.unwrap_or((m.context_window, m.preferred_window));
    Some(ModelCapabilities {
        model: model.clone(),
        context_window,
        preferred_window,
        max_output_tokens: m.max_output,
        supports_thinking: true,
        visible_thinking: true,
        supports_tools: true,
        supports_images: m.supports_images,
        effort_mode,
    })
}

/// Cautious (context, preferred, max output) for a model nobody knows, per provider.
pub fn fallback_limits(provider: &str) -> (u32, u32, u32) {
    match provider {
        "anthropic" | "google" => (200_000, 180_000, 32_000),
        "openai" => (272_000, 240_000, 32_000),
        _ => (128_000, 115_000, 16_000),
    }
}

pub fn fallback_capabilities(model: &ModelRef, effort_mode: EffortMode) -> ModelCapabilities {
    let (context_window, preferred_window, max_output_tokens) = fallback_limits(&model.provider);
    ModelCapabilities {
        model: model.clone(),
        context_window,
        preferred_window,
        max_output_tokens,
        supports_thinking: true,
        visible_thinking: true,
        supports_tools: true,
        supports_images: true,
        effort_mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(provider: &str, id: &str, label: &str, hidden: bool) -> String {
        let level = if provider == "kimi" { "high" } else { "low" };
        format!(
            r#"{{"provider":"{provider}","id":"{id}","label":"{label}","contextWindow":100,"preferredWindow":90,"maxOutput":10,"thinking":["off","{level}"],"defaultThinking":"{level}","hidden":{hidden}}}"#
        )
    }

    fn catalog(entries: &[String]) -> String {
        format!(r#"{{"format":1,"models":[{}]}}"#, entries.join(","))
    }

    fn one() -> String {
        catalog(&[entry("openai", "x", "X", false)])
    }

    #[test]
    fn embedded_catalog_is_valid() {
        assert!(!embedded().models.is_empty());
    }

    #[test]
    fn rejects_bad_catalogs() {
        assert!(parse("not json").is_err());
        assert!(parse(&one()).is_ok());
        assert!(parse(&one().replace("\"openai\"", "\"nope\"")).is_err());
        assert!(parse(&one().replace("\"defaultThinking\":\"low\"", "\"defaultThinking\":\"max\"")).is_err());
        assert!(parse(&one().replace("\"preferredWindow\":90", "\"preferredWindow\":900")).is_err());
        assert!(parse(&one().replace("\"format\":1", "\"format\":99")).is_err());
        assert!(parse(&one().replace("\"hidden\":false", "\"contextWindow1m\":5")).is_err());
        let dup = catalog(&[entry("openai", "x", "A", false), entry("openai", "x", "B", false)]);
        assert!(parse(&dup).is_err());
    }

    #[test]
    fn rejects_levels_that_adapters_would_silently_convert() {
        for (provider, id, rejected) in [
            ("kimi", "future", "low"),
            ("kimi", "future", "medium"),
            ("google", "future", "off"),
            ("google", "future-pro", "minimal"),
            ("xai", "future", "max"),
            ("anthropic", "future", "minimal"),
            ("openai", "future", "minimal"),
            ("openai", "gpt-5.3-codex-spark", "off"),
        ] {
            let mut value: serde_json::Value = serde_json::from_str(&one()).unwrap();
            let model = &mut value["models"][0];
            model["provider"] = provider.into();
            model["id"] = id.into();
            model["thinking"] = serde_json::json!([rejected]);
            model["defaultThinking"] = rejected.into();
            let error = parse(&value.to_string()).unwrap_err();
            assert!(error.contains("unsupported by this provider adapter"), "{provider}: {error}");
        }
    }

    #[test]
    fn accepts_supported_provider_levels() {
        for provider in CATALOG_PROVIDERS {
            let mut value: serde_json::Value = serde_json::from_str(&one()).unwrap();
            let model = &mut value["models"][0];
            let levels = thinking_levels(provider, "future");
            model["provider"] = (*provider).into();
            model["thinking"] = serde_json::json!(levels);
            model["defaultThinking"] = levels[0].into();
            assert!(parse(&value.to_string()).is_ok(), "{provider}");
        }
    }

    #[test]
    fn merge_remote_wins_adds_hides_and_orders() {
        let base = parse(&catalog(&[
            entry("openai", "a", "A built-in", false),
            entry("openai", "b", "B built-in", false),
            entry("kimi", "k", "K built-in", false),
        ]))
        .unwrap();
        let remote = parse(&catalog(&[
            entry("openai", "new", "New", false),
            entry("openai", "b", "B fixed", false),
            entry("kimi", "k", "K", true),
        ]))
        .unwrap();
        let merged = merge(&remote, &base);
        let ids: Vec<_> = merged.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["new", "b", "k", "a"]); // remote order first, then untouched built-ins
        assert_eq!(merged.models[1].label, "B fixed"); // remote wins
        assert!(merged.models[2].hidden); // hidden kept for the engine, UIs filter it
    }

    #[test]
    fn engine_lookup_uses_remote_then_embedded_then_fallback() {
        let remote = parse(&catalog(&[entry("openai", "brand-new", "N", true)])).unwrap();
        set(Some(remote));
        let caps = capabilities(&ModelRef::new("openai", "brand-new"), EffortMode::Tier).unwrap();
        assert_eq!((caps.context_window, caps.max_output_tokens), (100, 10)); // hidden still resolves
        assert!(capabilities(&ModelRef::new("openai", "gpt-5.5"), EffortMode::Tier).is_some()); // embedded kept
        assert!(capabilities(&ModelRef::new("openai", "unknown"), EffortMode::Tier).is_none());
        set(None);
        assert!(lookup("openai", "brand-new").is_none());
    }

    #[test]
    fn fallback_is_cautious_and_per_provider() {
        let anth = fallback_capabilities(&ModelRef::new("anthropic", "u"), EffortMode::Tier);
        let kimi = fallback_capabilities(&ModelRef::new("kimi", "u"), EffortMode::Flag);
        assert_eq!((anth.context_window, anth.max_output_tokens), (200_000, 32_000));
        assert_eq!((kimi.context_window, kimi.max_output_tokens), (128_000, 16_000));
    }
}
