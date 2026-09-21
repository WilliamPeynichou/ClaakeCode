//! TypeSafe (Jev) provider settings.
//!
//! A single, isolated provider that stores one API key. Unlike [`crate::prod`],
//! there is no CLI, no connection probing and no automatic use of the key: the
//! desktop app only persists it and reports whether one is configured. The raw
//! token never crosses the IPC boundary back to the frontend — only
//! [`TypeSafeSettings::has_token`] and a masked [`TypeSafeSettings::token_preview`].

use anyhow::{bail, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Stable identifier for the single TypeSafe provider.
pub const TYPESAFE_PROVIDER_ID: &str = "typesafe";

/// Environment variable the TypeSafe SDKs and HTTP API read.
pub const TYPESAFE_TOKEN_ENV_VAR: &str = "TYPESAFE_API_KEY";

/// Documentation entry point surfaced in the settings UI.
pub const TYPESAFE_DOCS_URL: &str = "https://docs.typesafe.ai";

/// Where users create an API key.
pub const TYPESAFE_CONSOLE_URL: &str = "https://console.typesafe.ai/keys";

/// Upper bound on a stored key, to reject obviously wrong pastes.
const TOKEN_MAX_CHARS: usize = 512;

/// Minimum length before a key is considered plausible.
const TOKEN_MIN_CHARS: usize = 8;

/// Public, secret-free view of the TypeSafe provider returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSafeSettings {
    pub provider_id: String,
    pub has_token: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<i64>,
    pub token_env_var: String,
    pub docs_url: String,
    pub console_url: String,
    #[serde(default)]
    pub secret_storage: TypeSafeSecretStorageInfo,
}

/// Describes how (and how well) the key is protected at rest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSafeSecretStorageInfo {
    pub kind: String,
    pub encrypted: bool,
    pub description: String,
}

impl Default for TypeSafeSecretStorageInfo {
    fn default() -> Self {
        Self {
            kind: "localPrivateFile".into(),
            encrypted: false,
            description: "No OS keychain integration exists in the current desktop stack; the TypeSafe API key is stored in a separate local auth file with 0600 permissions on Unix. This protects against casual reads but is not encrypted at rest.".into(),
        }
    }
}

impl Default for TypeSafeSettings {
    fn default() -> Self {
        Self::absent()
    }
}

impl TypeSafeSettings {
    /// State shown when no key has been saved yet.
    pub fn absent() -> Self {
        Self {
            provider_id: TYPESAFE_PROVIDER_ID.to_string(),
            has_token: false,
            token_preview: None,
            updated_at_ms: None,
            token_env_var: TYPESAFE_TOKEN_ENV_VAR.to_string(),
            docs_url: TYPESAFE_DOCS_URL.to_string(),
            console_url: TYPESAFE_CONSOLE_URL.to_string(),
            secret_storage: TypeSafeSecretStorageInfo::default(),
        }
    }

    /// State derived from a stored key. Only the mask is retained.
    pub fn from_token(token: &str, updated_at_ms: i64) -> Self {
        let token = token.trim();
        if token.is_empty() {
            return Self::absent();
        }
        Self {
            has_token: true,
            token_preview: typesafe_token_preview(token),
            updated_at_ms: Some(updated_at_ms),
            ..Self::absent()
        }
    }
}

/// Reject empty, oversized or multi-line keys before they reach disk.
pub fn validate_typesafe_token(token: &str) -> Result<String> {
    let token = token.trim();
    if token.is_empty() {
        bail!("TypeSafe API key cannot be empty");
    }
    if token.chars().any(char::is_whitespace) {
        bail!("TypeSafe API key cannot contain whitespace");
    }
    let length = token.chars().count();
    if length < TOKEN_MIN_CHARS {
        bail!("TypeSafe API key looks too short (expected at least {TOKEN_MIN_CHARS} characters)");
    }
    if length > TOKEN_MAX_CHARS {
        bail!("TypeSafe API key looks too long (expected at most {TOKEN_MAX_CHARS} characters)");
    }
    Ok(token.to_string())
}

/// Build the `••••abcd` mask shown in the settings UI.
pub fn typesafe_token_preview(token: &str) -> Option<String> {
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

/// Strip the stored key, and anything shaped like one, out of user-visible text.
pub fn redact_typesafe_secret_text(value: &str, secrets: &[String]) -> String {
    let mut redacted = value.to_string();
    for secret in secrets
        .iter()
        .map(|secret| secret.trim())
        .filter(|secret| secret.len() > 2)
    {
        redacted = redacted.replace(secret, "[redacted]");
    }

    let patterns = [
        r"(?i)\b((?:TYPESAFE_API_KEY|TYPESAFE[_-]?KEY|API[_-]?KEY)\s*[:=]\s*)([^\s;&]+)",
        r"(?i)\b(Authorization:\s*Bearer\s+)([^\s]+)",
    ];
    for pattern in patterns {
        if let Ok(regex) = Regex::new(pattern) {
            redacted = regex.replace_all(&redacted, "$1[redacted]").into_owned();
        }
    }
    redacted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_masks_all_but_last_four() {
        assert_eq!(
            typesafe_token_preview("sk_live_1234abcd"),
            Some("••••abcd".to_string())
        );
        assert_eq!(typesafe_token_preview("abc"), Some("••••".to_string()));
        assert_eq!(typesafe_token_preview("   "), None);
    }

    #[test]
    fn validation_rejects_bad_tokens() {
        assert!(validate_typesafe_token("").is_err());
        assert!(validate_typesafe_token("short").is_err());
        assert!(validate_typesafe_token("has whitespace here").is_err());
        assert!(validate_typesafe_token(&"x".repeat(TOKEN_MAX_CHARS + 1)).is_err());
        assert_eq!(
            validate_typesafe_token("  sk_live_1234abcd  ").unwrap(),
            "sk_live_1234abcd"
        );
    }

    #[test]
    fn redaction_removes_known_and_shaped_secrets() {
        let secrets = vec!["sk_live_1234abcd".to_string()];
        assert_eq!(
            redact_typesafe_secret_text("key=sk_live_1234abcd", &secrets),
            "key=[redacted]"
        );
        assert_eq!(
            redact_typesafe_secret_text("Authorization: Bearer zzzzzzzz", &[]),
            "Authorization: Bearer [redacted]"
        );
        assert_eq!(
            redact_typesafe_secret_text("TYPESAFE_API_KEY=abcdefgh", &[]),
            "TYPESAFE_API_KEY=[redacted]"
        );
    }

    #[test]
    fn settings_never_expose_raw_token() {
        let settings = TypeSafeSettings::from_token("sk_live_1234abcd", 42);
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("sk_live_1234abcd"));
        assert!(json.contains("••••abcd"));
        assert!(settings.has_token);
    }
}
