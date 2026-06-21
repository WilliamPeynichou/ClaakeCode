use claakecode_core::{EffortMode, ModelCapabilities, ModelRef};

use crate::client::MistralCatalogModel;

pub const PROVIDER_ID: &str = "mistral";
/// Reasonable default model when no live catalogue has been fetched yet.
pub const MODEL_ID: &str = "mistral-large-latest";

/// Build [`ModelCapabilities`] from a single field-by-field description.
pub fn capabilities_from_parts(
    model: &ModelRef,
    context_window: u32,
    max_output_tokens: u32,
    supports_images: bool,
    supports_tools: bool,
) -> ModelCapabilities {
    let context_window = context_window.max(1);
    let max_output_tokens = max_output_tokens.max(1).min(context_window);
    let preferred_window = context_window.saturating_sub(context_window / 16).max(1);
    ModelCapabilities {
        model: model.clone(),
        context_window,
        preferred_window,
        max_output_tokens,
        // Mistral standard chat models do not expose a reasoning channel.
        // Magistral models will surface that via a future `supports_thinking`
        // capability flag returned by /v1/models.
        supports_thinking: false,
        visible_thinking: false,
        supports_tools,
        supports_images,
        effort_mode: EffortMode::None,
    }
}

/// Build [`ModelCapabilities`] for a model returned by Mistral's `/v1/models`
/// endpoint.
pub fn capabilities_from_catalog_model(
    model: &ModelRef,
    catalog: &MistralCatalogModel,
) -> ModelCapabilities {
    capabilities_from_parts(
        model,
        catalog.context_window,
        catalog.max_output_tokens,
        catalog.supports_images,
        catalog.supports_tools,
    )
}

/// Fallback capabilities when the model is unknown (no catalogue fetched yet).
///
/// Tuned for Mistral Large 2 / Codestral 25.01 ranges.
pub fn fallback_capabilities(model: &ModelRef) -> ModelCapabilities {
    let (context, output, images, tools) = match model.name.as_str() {
        name if name.starts_with("codestral") => (262_144, 8_192, false, true),
        name if name.starts_with("pixtral") => (131_072, 8_192, true, true),
        name if name.starts_with("ministral") => (131_072, 8_192, false, true),
        _ => (131_072, 8_192, true, true),
    };
    capabilities_from_parts(model, context, output, images, tools)
}
