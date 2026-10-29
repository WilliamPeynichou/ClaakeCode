use claakecode_core::{EffortMode, ModelCapabilities, ModelRef};

pub const MODEL_ID: &str = "kimi-k2.7-code";
pub const MODEL_WINDOW: u32 = 256_000;
pub const MODEL_MAX_OUTPUT: u32 = 32_000;

struct KimiModelInfo {
    id: &'static str,
    context_window: u32,
    preferred_window: u32,
    max_output_tokens: u32,
    thinking_only: bool,
}

const MODELS: &[KimiModelInfo] = &[
    KimiModelInfo {
        id: "kimi-k2.7-code",
        context_window: MODEL_WINDOW,
        preferred_window: 230_000,
        max_output_tokens: MODEL_MAX_OUTPUT,
        thinking_only: true,
    },
    KimiModelInfo {
        id: "kimi-3.1-pro",
        context_window: MODEL_WINDOW,
        preferred_window: 230_000,
        max_output_tokens: MODEL_MAX_OUTPUT,
        thinking_only: false,
    },
    KimiModelInfo {
        id: "kimi-for-coding",
        context_window: MODEL_WINDOW,
        preferred_window: 230_000,
        max_output_tokens: MODEL_MAX_OUTPUT,
        thinking_only: false,
    },
];

pub fn is_thinking_only(model_id: &str) -> bool {
    if let Some(m) = claakecode_core::catalog::lookup("kimi", model_id) {
        return !m.thinking.iter().any(|t| t == "off");
    }
    MODELS
        .iter()
        .find(|info| info.id == model_id)
        .map(|info| info.thinking_only)
        .unwrap_or(false)
}

pub fn capabilities(model: &ModelRef) -> ModelCapabilities {
    if let Some(caps) = claakecode_core::catalog::capabilities(model, EffortMode::Flag) {
        return caps;
    }
    let Some(info) = MODELS.iter().find(|info| info.id == model.name) else {
        return claakecode_core::catalog::fallback_capabilities(model, EffortMode::Flag);
    };
    ModelCapabilities {
        model: model.clone(),
        context_window: info.context_window,
        preferred_window: info.preferred_window,
        max_output_tokens: info.max_output_tokens,
        supports_thinking: true,
        visible_thinking: true,
        supports_tools: true,
        supports_images: true,
        effort_mode: EffortMode::Flag,
    }
}
