use claakecode_core::{Effort, EffortMode, ModelCapabilities, ModelRef};

pub const MODEL_ID: &str = "gemini-3.1-pro";
pub const GEMINI_WINDOW: u32 = 1_048_576;
pub const GEMINI_MAX_OUTPUT: u32 = 65_535;

struct GoogleModelInfo {
    id: &'static str,
    context_window: u32,
    preferred_window: u32,
    max_output_tokens: u32,
    supports_images: bool,
}

const MODELS: &[GoogleModelInfo] = &[
    GoogleModelInfo {
        id: "gemini-3.1-pro",
        context_window: GEMINI_WINDOW,
        preferred_window: 950_000,
        max_output_tokens: GEMINI_MAX_OUTPUT,
        supports_images: true,
    },
    GoogleModelInfo {
        id: "gemini-3-flash",
        context_window: GEMINI_WINDOW,
        preferred_window: 950_000,
        max_output_tokens: GEMINI_MAX_OUTPUT,
        supports_images: true,
    },
    GoogleModelInfo {
        id: "gemini-3.5-flash",
        context_window: GEMINI_WINDOW,
        preferred_window: 950_000,
        max_output_tokens: GEMINI_MAX_OUTPUT,
        supports_images: true,
    },
    GoogleModelInfo {
        id: "gemini-3.1-flash-lite",
        context_window: GEMINI_WINDOW,
        preferred_window: 950_000,
        max_output_tokens: GEMINI_MAX_OUTPUT,
        supports_images: true,
    },
];

/// Legacy / thinking-suffixed names that map onto a canonical model (mirrors `models.ts`).
fn alias_target(name: &str) -> Option<&'static str> {
    match name {
        "gemini-3.1-pro-preview" | "gemini-3.1-pro-low" | "gemini-3.1-pro-high" => {
            Some("gemini-3.1-pro")
        }
        "gemini-3-flash-preview" => Some("gemini-3-flash"),
        "gemini-3.5-flash-low" | "gemini-3.5-flash-medium" | "gemini-3.5-flash-high" => {
            Some("gemini-3.5-flash")
        }
        _ => None,
    }
}

/// Resolves aliases; any other name is kept as requested (catalog models, or a model the
/// provider will accept or reject itself) instead of being silently swapped for Pro.
pub fn canonical_model(model: &ModelRef) -> ModelRef {
    let mut canonical = model.clone();
    if let Some(target) = alias_target(&canonical.name) {
        canonical.name = target.into();
    }
    canonical
}

pub fn antigravity_model_and_thinking(
    model: &ModelRef,
    effort: Option<Effort>,
) -> (String, Option<&'static str>) {
    let base = canonical_model(model).name;
    let requested = effort.or(model.effort).unwrap_or(Effort::High);
    let is_pro = is_gemini_pro_model(&base);
    let thinking_level = match requested {
        // Antigravity's pro models do not accept `minimal`; clamp them to low.
        Effort::None => {
            if is_pro {
                "low"
            } else {
                "minimal"
            }
        }
        Effort::Low => "low",
        Effort::Medium => "medium",
        Effort::High | Effort::Xhigh | Effort::Max => "high",
    };

    // Antigravity exposes 3.5-flash uniquement sous l'ID `gemini-3.5-flash-low`.
    // Le thinkingLevel reste libre, mais l'ID modèle est figé.
    if base == "gemini-3.5-flash" {
        return ("gemini-3.5-flash-low".into(), Some(thinking_level));
    }
    // Gemini 3.1 Pro on Antigravity is always routed to the agentic variant
    // (`gemini-pro-agent`), which is the fine-tuned artefact for tool use and
    // long thinking. The `thinkingLevel` is still variable.
    if base == "gemini-3.1-pro" {
        return ("gemini-pro-agent".into(), Some(thinking_level));
    }
    if is_pro {
        (format!("{base}-{thinking_level}"), Some(thinking_level))
    } else {
        (base, Some(thinking_level))
    }
}

pub fn capabilities(model: &ModelRef) -> ModelCapabilities {
    let model = canonical_model(model);
    if let Some(caps) = claakecode_core::catalog::capabilities(&model, EffortMode::Tier) {
        return caps;
    }
    let Some(info) = MODELS.iter().find(|info| info.id == model.name) else {
        return claakecode_core::catalog::fallback_capabilities(&model, EffortMode::Tier);
    };
    ModelCapabilities {
        model,
        context_window: info.context_window,
        preferred_window: info.preferred_window,
        max_output_tokens: info.max_output_tokens,
        supports_thinking: true,
        visible_thinking: true,
        supports_tools: true,
        supports_images: info.supports_images,
        effort_mode: EffortMode::Tier,
    }
}

pub fn is_gemini3_model(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    // Antigravity exposes several aliases for Gemini 3.x family. They all
    // share the same thought_signature / multimodal function response
    // requirements, so treat them uniformly.
    lower.contains("gemini-3")
        || lower == "gemini-pro-agent"
        || lower.starts_with("gemini-pro-agent")
}

fn is_gemini_pro_model(model_id: &str) -> bool {
    model_id.to_ascii_lowercase().contains("-pro")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_resolve_and_unknown_names_are_kept() {
        let name = |n: &str| canonical_model(&ModelRef::new("google", n)).name;
        assert_eq!(name("gemini-3.1-pro-high"), "gemini-3.1-pro");
        assert_eq!(name("gemini-3-flash-preview"), "gemini-3-flash");
        assert_eq!(name("gemini-3.5-flash-medium"), "gemini-3.5-flash");
        assert_eq!(name("gemini-3.5-flash"), "gemini-3.5-flash");
        assert_eq!(name("gemini-9-future"), "gemini-9-future");
    }

    #[test]
    fn unknown_model_gets_cautious_limits_and_keeps_its_id() {
        let caps = capabilities(&ModelRef::new("google", "gemini-9-future"));
        assert_eq!(caps.model.name, "gemini-9-future");
        assert_eq!((caps.context_window, caps.max_output_tokens), (200_000, 32_000));
        let known = capabilities(&ModelRef::new("google", "gemini-3.1-pro"));
        assert_eq!(known.context_window, GEMINI_WINDOW);
    }

    #[test]
    fn unknown_flash_model_passes_through_antigravity_unchanged() {
        let (id, level) =
            antigravity_model_and_thinking(&ModelRef::new("google", "gemini-9-flash"), None);
        assert_eq!((id.as_str(), level), ("gemini-9-flash", Some("high")));
    }
}
