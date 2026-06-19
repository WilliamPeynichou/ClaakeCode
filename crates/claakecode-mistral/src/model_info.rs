use claakecode_core::{EffortMode, ModelCapabilities, ModelRef};

pub const PROVIDER_ID: &str = "mistral";
pub const MODEL_ID: &str = "mistral-large-latest";

struct MistralModelInfo {
    id: &'static str,
    context_window: u32,
    preferred_window: u32,
    max_output_tokens: u32,
    supports_images: bool,
    supports_tools: bool,
}

const MODELS: &[MistralModelInfo] = &[
    MistralModelInfo {
        id: "mistral-large-latest",
        context_window: 131_072,
        preferred_window: 120_000,
        max_output_tokens: 8_192,
        supports_images: true,
        supports_tools: true,
    },
    MistralModelInfo {
        id: "mistral-medium-latest",
        context_window: 131_072,
        preferred_window: 120_000,
        max_output_tokens: 8_192,
        supports_images: true,
        supports_tools: true,
    },
    MistralModelInfo {
        id: "mistral-small-latest",
        context_window: 131_072,
        preferred_window: 120_000,
        max_output_tokens: 8_192,
        supports_images: true,
        supports_tools: true,
    },
    MistralModelInfo {
        id: "codestral-latest",
        context_window: 262_144,
        preferred_window: 240_000,
        max_output_tokens: 8_192,
        supports_images: false,
        supports_tools: true,
    },
];

fn model_info(model_id: &str) -> &'static MistralModelInfo {
    MODELS
        .iter()
        .find(|info| info.id == model_id)
        .unwrap_or(&MODELS[0])
}

pub fn capabilities(model: &ModelRef) -> ModelCapabilities {
    let info = model_info(&model.name);
    ModelCapabilities {
        model: model.clone(),
        context_window: info.context_window,
        preferred_window: info.preferred_window,
        max_output_tokens: info.max_output_tokens,
        // The default Mistral chat models do not expose a reasoning channel.
        supports_thinking: false,
        visible_thinking: false,
        supports_tools: info.supports_tools,
        supports_images: info.supports_images,
        effort_mode: EffortMode::None,
    }
}
