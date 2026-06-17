use std::collections::HashSet;

use anyhow::{bail, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};

const STATUS_MESSAGE_LIMIT: usize = 2_000;

/// FeatureProd v1 provider identifiers. Tokens are persisted only for this
/// allow-list so an arbitrary frontend payload cannot create unexpected secret
/// entries.
pub const PROD_PROVIDER_IDS: &[&str] = &[
    "vercel",
    "railway",
    "netlify",
    "render",
    "fly",
    "heroku",
    "cloudflare",
    "supabase",
];

pub const PROD_TOKEN_ENV_KEYS: &[(&str, &str)] = &[
    ("vercel", "VERCEL_TOKEN"),
    ("railway", "RAILWAY_TOKEN"),
    ("netlify", "NETLIFY_AUTH_TOKEN"),
    ("render", "RENDER_API_KEY"),
    ("fly", "FLY_API_TOKEN"),
    ("heroku", "HEROKU_API_KEY"),
    ("cloudflare", "CLOUDFLARE_API_TOKEN"),
    ("supabase", "SUPABASE_ACCESS_TOKEN"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProdSettings {
    #[serde(default)]
    pub providers: Vec<ProdProviderSettings>,
    #[serde(default)]
    pub secret_storage: ProdSecretStorageInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProdSecretStorageInfo {
    pub kind: String,
    pub encrypted: bool,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProdProviderSettings {
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub has_token: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<ProdProviderCachedStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProdProviderConnectionState {
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "connected")]
    Connected,
    #[serde(rename = "disconnected")]
    Disconnected,
    #[serde(rename = "error")]
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProdProviderCachedStatus {
    #[serde(default)]
    pub state: ProdProviderConnectionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_installed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProdProviderSecretState {
    pub provider_id: String,
    pub has_token: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<i64>,
}

impl Default for ProdSettings {
    fn default() -> Self {
        Self {
            providers: PROD_PROVIDER_IDS
                .iter()
                .map(|provider_id| ProdProviderSettings::for_provider(provider_id))
                .collect(),
            secret_storage: ProdSecretStorageInfo::default(),
        }
    }
}

impl Default for ProdSecretStorageInfo {
    fn default() -> Self {
        Self {
            kind: "localPrivateFile".into(),
            encrypted: false,
            description: "No OS keychain integration exists in the current desktop stack; Prod tokens are stored in a separate local auth file with 0600 permissions on Unix. This protects against casual reads but is not encrypted at rest.".into(),
        }
    }
}

impl Default for ProdProviderConnectionState {
    fn default() -> Self {
        Self::Unknown
    }
}

impl ProdSettings {
    pub fn normalized(mut self) -> Self {
        let mut by_id = self
            .providers
            .drain(..)
            .filter_map(ProdProviderSettings::normalized)
            .map(|provider| (provider.provider_id.clone(), provider))
            .collect::<std::collections::HashMap<_, _>>();
        let mut seen = HashSet::new();
        let mut providers = Vec::new();
        for provider_id in PROD_PROVIDER_IDS {
            if !seen.insert((*provider_id).to_string()) {
                continue;
            }
            let provider = by_id
                .remove(*provider_id)
                .unwrap_or_else(|| ProdProviderSettings::for_provider(provider_id));
            providers.push(provider.without_secret_state());
        }
        Self {
            providers,
            secret_storage: ProdSecretStorageInfo::default(),
        }
    }

    pub fn normalized_for_save(self) -> Result<Self> {
        let normalized = self.normalized();
        normalized.validate()?;
        Ok(normalized)
    }

    pub fn validate(&self) -> Result<()> {
        for provider in &self.providers {
            validate_prod_provider_id(&provider.provider_id)?;
        }
        Ok(())
    }

    pub fn apply_secret_states(&mut self, states: &[ProdProviderSecretState]) {
        for provider in &mut self.providers {
            if let Some(state) = states
                .iter()
                .find(|state| state.provider_id == provider.provider_id)
            {
                provider.has_token = state.has_token;
                provider.token_preview = state.token_preview.clone();
            } else {
                provider.has_token = false;
                provider.token_preview = None;
            }
        }
    }

    pub fn redacted_with_secrets(mut self, secrets: &[String]) -> Self {
        for provider in &mut self.providers {
            if let Some(status) = &mut provider.last_status {
                status.redact_with_secrets(secrets);
            }
        }
        self
    }
}

impl ProdProviderSettings {
    pub fn for_provider(provider_id: &str) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            has_token: false,
            token_preview: None,
            last_status: None,
        }
    }

    fn normalized(mut self) -> Option<Self> {
        self.provider_id = normalize_prod_provider_id(&self.provider_id)?;
        self.last_status = self.last_status.map(ProdProviderCachedStatus::normalized);
        Some(self.without_secret_state())
    }

    fn without_secret_state(mut self) -> Self {
        self.has_token = false;
        self.token_preview = None;
        self
    }
}

impl ProdProviderCachedStatus {
    fn normalized(mut self) -> Self {
        self.identity = self
            .identity
            .map(|value| {
                clip_chars(
                    redact_prod_secret_text(&value, &[]).trim(),
                    STATUS_MESSAGE_LIMIT,
                )
            })
            .filter(|value| !value.is_empty());
        self.message = self
            .message
            .map(|value| {
                clip_chars(
                    redact_prod_secret_text(&value, &[]).trim(),
                    STATUS_MESSAGE_LIMIT,
                )
            })
            .filter(|value| !value.is_empty());
        if self.state == ProdProviderConnectionState::Unknown {
            self.message = None;
        }
        self
    }

    fn redact_with_secrets(&mut self, secrets: &[String]) {
        if let Some(identity) = &self.identity {
            self.identity = Some(clip_chars(
                redact_prod_secret_text(identity, secrets).trim(),
                STATUS_MESSAGE_LIMIT,
            ));
        }
        if let Some(message) = &self.message {
            self.message = Some(clip_chars(
                redact_prod_secret_text(message, secrets).trim(),
                STATUS_MESSAGE_LIMIT,
            ));
        }
    }
}

impl ProdProviderSecretState {
    pub fn from_token(provider_id: &str, token: &str, updated_at_ms: i64) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            has_token: !token.trim().is_empty(),
            token_preview: prod_token_preview(token),
            updated_at_ms: Some(updated_at_ms),
        }
    }

    pub fn absent(provider_id: &str) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            has_token: false,
            token_preview: None,
            updated_at_ms: None,
        }
    }
}

pub fn normalize_prod_provider_id(provider_id: &str) -> Option<String> {
    let normalized = provider_id
        .trim()
        .to_ascii_lowercase()
        .replace('_', "-")
        .replace(' ', "-");
    let canonical = match normalized.as_str() {
        "vercel" => "vercel",
        "railway" => "railway",
        "netlify" => "netlify",
        "render" => "render",
        "fly" | "flyio" | "fly-io" | "fly.io" | "flyctl" => "fly",
        "heroku" => "heroku",
        "cloudflare" | "cloudflare-wrangler" | "wrangler" => "cloudflare",
        "supabase" => "supabase",
        _ => return None,
    };
    Some(canonical.to_string())
}

pub fn validate_prod_provider_id(provider_id: &str) -> Result<String> {
    normalize_prod_provider_id(provider_id).ok_or_else(|| {
        anyhow::anyhow!(
            "unsupported Prod provider `{}`; expected one of: {}",
            provider_id.trim(),
            PROD_PROVIDER_IDS.join(", ")
        )
    })
}

pub fn prod_token_env_var(provider_id: &str) -> Option<&'static str> {
    let provider_id = normalize_prod_provider_id(provider_id)?;
    PROD_TOKEN_ENV_KEYS
        .iter()
        .find_map(|(id, key)| (*id == provider_id).then_some(*key))
}

pub fn validate_prod_token(token: &str) -> Result<String> {
    let token = token.trim();
    if token.is_empty() {
        bail!("Prod token cannot be empty");
    }
    Ok(token.to_string())
}

pub fn prod_token_preview(token: &str) -> Option<String> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    let chars = token.chars().collect::<Vec<_>>();
    if chars.len() <= 4 {
        return Some("••••".to_string());
    }
    let suffix = chars
        .iter()
        .rev()
        .take(4)
        .copied()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    Some(format!("••••{suffix}"))
}

pub fn redact_prod_secret_text(value: &str, secrets: &[String]) -> String {
    let mut redacted = value.to_string();
    for secret in secrets
        .iter()
        .map(|secret| secret.trim())
        .filter(|secret| secret.len() > 2)
    {
        redacted = redacted.replace(secret, "[redacted]");
    }

    let patterns = [
        r"(?i)\b((?:VERCEL_TOKEN|RAILWAY_TOKEN|NETLIFY_AUTH_TOKEN|RENDER_API_KEY|FLY_API_TOKEN|HEROKU_API_KEY|CLOUDFLARE_API_TOKEN|SUPABASE_ACCESS_TOKEN|API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET[_-]?KEY|TOKEN)\s*[:=]\s*)([^\s;&]+)",
        r"(?i)\b(Authorization:\s*Bearer\s+)([^\s]+)",
        r"(?i)\b(--(?:token|auth-token|api-key)\s+)([^\s]+)",
    ];
    for pattern in patterns {
        if let Ok(regex) = Regex::new(pattern) {
            redacted = regex.replace_all(&redacted, "$1[redacted]").into_owned();
        }
    }
    redacted
}

fn clip_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit).collect()
}
