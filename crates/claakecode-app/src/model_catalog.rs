//! Fetch/cache of the remote model catalog (`models.json` on GitHub `main`).
//! Never fatal: any failure keeps the cached catalog, then the built-in one.

use std::time::Duration;

use claakecode_core::catalog;

use crate::store::AppStore;

const CATALOG_URL: &str =
    "https://raw.githubusercontent.com/WilliamPeynichou/ClaakeCode/main/models.json";

/// Load the last valid cached catalog into the engine (sync, call before building providers).
pub fn load_cached(store: &AppStore) {
    if let Some(json) = store.load_model_catalog_json() {
        match catalog::parse(&json) {
            Ok(c) => catalog::set(Some(c)),
            Err(err) => tracing::warn!("cached model catalog rejected: {err}"),
        }
    }
}

/// Download once (3 s max) and activate. Returns true when a new catalog was applied.
/// Called once per app launch from the Rust side, never from UI windows.
pub async fn refresh(store: &AppStore) -> bool {
    match fetch(store).await {
        Ok(()) => true,
        Err(err) => {
            tracing::warn!("model catalog refresh failed: {err}");
            false
        }
    }
}

async fn fetch(store: &AppStore) -> anyhow::Result<()> {
    let body = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()?
        .get(CATALOG_URL)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    apply_body(store, &body)
}

/// Validate, cache and activate. An invalid body changes nothing (previous cache is kept).
fn apply_body(store: &AppStore, body: &str) -> anyhow::Result<()> {
    let parsed = catalog::parse(body).map_err(anyhow::Error::msg)?;
    store.save_model_catalog_json(body)?;
    catalog::set(Some(parsed));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"format":1,"models":[{"provider":"openai","id":"cached-model","label":"C","contextWindow":100,"preferredWindow":90,"maxOutput":10,"thinking":["off"],"defaultThinking":"off"}]}"#;

    #[test]
    fn invalid_body_keeps_previous_cache_and_cache_is_reloaded() {
        let store = AppStore::in_memory().unwrap();
        assert!(apply_body(&store, "{broken").is_err());
        assert!(store.load_model_catalog_json().is_none());

        apply_body(&store, GOOD).unwrap();
        assert!(apply_body(&store, r#"{"format":99,"models":[]}"#).is_err());
        assert_eq!(store.load_model_catalog_json().as_deref(), Some(GOOD)); // previous kept

        catalog::set(None);
        load_cached(&store); // offline relaunch
        assert!(catalog::lookup("openai", "cached-model").is_some());
        catalog::set(None);
    }
}
