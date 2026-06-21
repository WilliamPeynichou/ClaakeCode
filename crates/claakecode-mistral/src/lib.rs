mod auth;
mod client;
mod model_info;
mod stream;
mod wire;

pub use auth::{
    delete_default_auth, exchange_oauth_code, generate_pkce, generate_state,
    load_default_api_key, load_default_auth_status, oauth_authorize_url, save_default_api_key,
    touch_default_auth_validation, Credential, MistralAuthStatus, PkceCodes,
    MISTRAL_API_KEY_ENV, MISTRAL_OAUTH_AUTHORIZE_URL_ENV, MISTRAL_OAUTH_CLIENT_ID_ENV,
    MISTRAL_OAUTH_SCOPE_ENV, MISTRAL_OAUTH_TOKEN_URL_ENV,
};
pub use client::{
    fetch_model_catalog, validate_api_key, MistralCatalogModel, MistralConfig, MistralProvider,
};
pub use model_info::{
    capabilities_from_catalog_model, capabilities_from_parts, fallback_capabilities, MODEL_ID,
    PROVIDER_ID,
};
