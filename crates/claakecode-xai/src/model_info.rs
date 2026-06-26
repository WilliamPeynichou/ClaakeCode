use claakecode_core::{EffortMode, ModelCapabilities, ModelRef};

pub const PROVIDER_ID: &str = "xai";
pub const MODEL_ID: &str = "composer-2.5";
pub const MODEL_DISPLAY_NAME: &str = "Composer 2.5";
pub const MODEL_WINDOW: u32 = 256_000;
pub const MODEL_MAX_OUTPUT: u32 = 128_000;

pub fn capabilities(model: &ModelRef) -> Option<ModelCapabilities> {
    if model.provider != PROVIDER_ID || model.name != MODEL_ID {
        return None;
    }

    Some(ModelCapabilities {
        model: model.clone(),
        context_window: MODEL_WINDOW,
        preferred_window: 230_000,
        max_output_tokens: MODEL_MAX_OUTPUT,
        supports_thinking: true,
        visible_thinking: true,
        supports_tools: true,
        supports_images: true,
        effort_mode: EffortMode::Tier,
    })
}
