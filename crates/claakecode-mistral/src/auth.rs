use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use directories::ProjectDirs;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use claakecode_core::{AppError, Result};

use crate::model_info::PROVIDER_ID;

/// Environment variable that lets users provide a Mistral API key without
/// going through the Settings UI (useful for CI / headless usage).
pub const MISTRAL_API_KEY_ENV: &str = "MISTRAL_API_KEY";

/// Optional environment overrides for the OAuth flow. These let downstream
/// distributions plug their own OAuth client without recompiling.
pub const MISTRAL_OAUTH_CLIENT_ID_ENV: &str = "MISTRAL_OAUTH_CLIENT_ID";
pub const MISTRAL_OAUTH_AUTHORIZE_URL_ENV: &str = "MISTRAL_OAUTH_AUTHORIZE_URL";
pub const MISTRAL_OAUTH_TOKEN_URL_ENV: &str = "MISTRAL_OAUTH_TOKEN_URL";
pub const MISTRAL_OAUTH_SCOPE_ENV: &str = "MISTRAL_OAUTH_SCOPE";

const DEFAULT_MISTRAL_OAUTH_AUTHORIZE_URL: &str = "https://auth.mistral.ai/oauth/authorize";
const DEFAULT_MISTRAL_OAUTH_TOKEN_URL: &str = "https://auth.mistral.ai/oauth/token";
const DEFAULT_MISTRAL_OAUTH_SCOPE: &str = "openid profile email offline_access";

const REFRESH_SKEW_MS: i64 = 5 * 60_000;

pub(crate) const MISTRAL_RECONNECT_MESSAGE: &str =
    "Mistral credentials were rejected. Please reconnect Mistral in Settings > Providers.";

#[derive(Clone)]
pub enum Credential {
    ApiKey(String),
    OAuth(Arc<Mutex<OAuthToken>>),
}

pub struct OAuthToken {
    access: String,
    refresh: String,
    expires_at_ms: i64,
    source_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MistralAuthStatus {
    pub connected: bool,
    pub auth_mode: Option<String>,
    pub key_preview: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub last_refresh_ms: Option<i64>,
    pub last_validated_ms: Option<i64>,
}

impl MistralAuthStatus {
    pub fn disconnected() -> Self {
        Self {
            connected: false,
            auth_mode: None,
            key_preview: None,
            expires_at_ms: None,
            last_refresh_ms: None,
            last_validated_ms: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PkceCodes {
    pub code_verifier: String,
    pub code_challenge: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAuth {
    provider: String,
    auth_mode: String,
    tokens: StoredTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_refresh_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_validated_ms: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTokens {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    api_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    access_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    refresh_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<i64>,
}

impl Credential {
    pub fn from_api_key(api_key: impl Into<String>) -> Self {
        Self::ApiKey(api_key.into())
    }

    pub fn from_oauth_parts(
        access: impl Into<String>,
        refresh: impl Into<String>,
        expires_at_ms: i64,
        source_path: Option<PathBuf>,
    ) -> Self {
        Self::OAuth(Arc::new(Mutex::new(OAuthToken {
            access: access.into(),
            refresh: refresh.into(),
            expires_at_ms,
            source_path,
        })))
    }

    /// Resolve a credential from (in order): the `MISTRAL_API_KEY` environment
    /// variable, then the stored auth file written by the Settings UI (OAuth
    /// preferred, then API key).
    pub fn load_default() -> Result<Option<Self>> {
        if let Ok(api_key) = std::env::var(MISTRAL_API_KEY_ENV) {
            let api_key = api_key.trim();
            if !api_key.is_empty() {
                return Ok(Some(Self::from_api_key(api_key.to_string())));
            }
        }
        Self::from_claakecode_auth_file(&default_auth_path()?)
    }

    pub fn from_claakecode_auth_file(path: &Path) -> Result<Option<Self>> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(AppError::Auth(format!("unable to read auth file: {err}"))),
        };

        let payload: StoredAuth = serde_json::from_slice(&bytes)
            .map_err(|err| AppError::Auth(format!("invalid auth file: {err}")))?;
        if payload.provider != PROVIDER_ID {
            return Ok(None);
        }
        match payload.auth_mode.as_str() {
            "oauth" => {
                if payload.tokens.access_token.is_empty() {
                    return Err(AppError::Auth(
                        "mistral oauth is missing access token".into(),
                    ));
                }
                Ok(Some(Self::from_oauth_parts(
                    payload.tokens.access_token,
                    payload.tokens.refresh_token,
                    payload.tokens.expires_at_ms.unwrap_or(0),
                    Some(path.to_path_buf()),
                )))
            }
            "api_key" => {
                let api_key = payload.tokens.api_key.trim();
                if api_key.is_empty() {
                    return Err(AppError::Auth("mistral auth is missing API key".into()));
                }
                Ok(Some(Self::from_api_key(api_key.to_string())))
            }
            _ => Ok(None),
        }
    }

    pub fn is_oauth(&self) -> bool {
        matches!(self, Self::OAuth(_))
    }

    /// Return a bearer token suitable for the `Authorization: Bearer …` header,
    /// transparently refreshing the OAuth access token when needed.
    pub async fn bearer(&self, http: &reqwest::Client) -> Result<String> {
        match self {
            Self::ApiKey(key) => Ok(key.clone()),
            Self::OAuth(state) => oauth_access(state, http, None).await,
        }
    }

    /// Force-refresh the OAuth access token when the previously seen access
    /// value was rejected by the server.
    pub async fn force_refresh(
        &self,
        http: &reqwest::Client,
        previous_access: &str,
    ) -> Result<String> {
        match self {
            Self::ApiKey(_) => Err(AppError::Auth(MISTRAL_RECONNECT_MESSAGE.into())),
            Self::OAuth(state) => oauth_access(state, http, Some(previous_access)).await,
        }
    }
}

async fn oauth_access(
    state: &Arc<Mutex<OAuthToken>>,
    http: &reqwest::Client,
    refresh_access: Option<&str>,
) -> Result<String> {
    let mut guard = state.lock().await;
    if let Some(previous_access) = refresh_access {
        if guard.access != previous_access {
            return Ok(guard.access.clone());
        }
    } else if !is_expired(guard.expires_at_ms) {
        return Ok(guard.access.clone());
    }

    if guard.refresh.is_empty() {
        return Err(AppError::Auth(MISTRAL_RECONNECT_MESSAGE.into()));
    }

    let fresh = refresh_token(http, &guard.refresh).await?;
    let expires_at_ms = expires_at(fresh.expires_in);
    guard.access = fresh.access_token.clone();
    if !fresh.refresh_token.is_empty() {
        guard.refresh = fresh.refresh_token.clone();
    }
    guard.expires_at_ms = expires_at_ms;
    let source_path = guard.source_path.clone();
    let refresh_for_disk = guard.refresh.clone();
    drop(guard);

    if let Some(path) = source_path {
        if let Err(err) = persist_refresh(
            &path,
            &fresh.access_token,
            &refresh_for_disk,
            expires_at_ms,
        ) {
            tracing::warn!(error = %err, "failed to persist refreshed mistral oauth token");
        }
    }

    Ok(fresh.access_token)
}

fn is_expired(expires_at_ms: i64) -> bool {
    now_ms() + REFRESH_SKEW_MS >= expires_at_ms
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn expires_at(expires_in_seconds: u64) -> i64 {
    now_ms() + (expires_in_seconds as i64 * 1000) - REFRESH_SKEW_MS
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default = "default_expires_in")]
    expires_in: u64,
}

fn default_expires_in() -> u64 {
    3600
}

fn oauth_client_id() -> Result<String> {
    std::env::var(MISTRAL_OAUTH_CLIENT_ID_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            AppError::Auth(format!(
                "Mistral OAuth client id is not configured. Set {MISTRAL_OAUTH_CLIENT_ID_ENV} \
                 or paste an API key in Settings."
            ))
        })
}

fn oauth_authorize_endpoint() -> String {
    std::env::var(MISTRAL_OAUTH_AUTHORIZE_URL_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_MISTRAL_OAUTH_AUTHORIZE_URL.to_string())
}

fn oauth_token_endpoint() -> String {
    std::env::var(MISTRAL_OAUTH_TOKEN_URL_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_MISTRAL_OAUTH_TOKEN_URL.to_string())
}

fn oauth_scope() -> String {
    std::env::var(MISTRAL_OAUTH_SCOPE_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_MISTRAL_OAUTH_SCOPE.to_string())
}

async fn refresh_token(http: &reqwest::Client, refresh_token: &str) -> Result<TokenResponse> {
    let client_id = oauth_client_id()?;
    let response = http
        .post(oauth_token_endpoint())
        .header("accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|err| AppError::Network(format!("mistral oauth refresh failed: {err}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Auth(format!(
            "mistral oauth refresh failed with {status}: {body}"
        )));
    }

    response
        .json()
        .await
        .map_err(|err| AppError::Decode(format!("invalid mistral oauth refresh body: {err}")))
}

pub fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn generate_pkce() -> PkceCodes {
    let code_verifier = generate_state();
    let digest = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(digest);
    PkceCodes {
        code_verifier,
        code_challenge,
    }
}

pub fn oauth_authorize_url(redirect_uri: &str, pkce: &PkceCodes, state: &str) -> Result<String> {
    let client_id = oauth_client_id()?;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer
        .append_pair("client_id", &client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &oauth_scope())
        .append_pair("code_challenge", &pkce.code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(format!(
        "{}?{}",
        oauth_authorize_endpoint(),
        serializer.finish()
    ))
}

pub async fn exchange_oauth_code(
    http: &reqwest::Client,
    code: &str,
    _state: &str,
    redirect_uri: &str,
    pkce: &PkceCodes,
) -> Result<MistralAuthStatus> {
    let client_id = oauth_client_id()?;
    let response = http
        .post(oauth_token_endpoint())
        .header("accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id.as_str()),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", pkce.code_verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|err| AppError::Network(format!("mistral oauth exchange failed: {err}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Auth(format!(
            "mistral oauth exchange failed with {status}: {body}"
        )));
    }

    let body: TokenResponse = response
        .json()
        .await
        .map_err(|err| AppError::Decode(format!("invalid mistral oauth body: {err}")))?;
    save_oauth_tokens(
        &default_auth_path()?,
        &body.access_token,
        &body.refresh_token,
        body.expires_in,
    )
}

fn save_oauth_tokens(
    path: &Path,
    access_token: &str,
    refresh_token: &str,
    expires_in: u64,
) -> Result<MistralAuthStatus> {
    let auth = StoredAuth {
        provider: PROVIDER_ID.into(),
        auth_mode: "oauth".into(),
        tokens: StoredTokens {
            access_token: access_token.into(),
            refresh_token: refresh_token.into(),
            expires_at_ms: Some(expires_at(expires_in)),
            ..Default::default()
        },
        last_refresh_ms: Some(now_ms()),
        last_validated_ms: Some(now_ms()),
    };
    write_auth_file(path, &auth)?;
    Ok(status_from_auth(&auth))
}

pub fn load_default_api_key() -> Result<Option<String>> {
    if let Ok(api_key) = std::env::var(MISTRAL_API_KEY_ENV) {
        let api_key = api_key.trim();
        if !api_key.is_empty() {
            return Ok(Some(api_key.to_string()));
        }
    }
    let path = default_auth_path()?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(AppError::Auth(format!("unable to read auth file: {err}"))),
    };
    let payload: StoredAuth = serde_json::from_slice(&bytes)
        .map_err(|err| AppError::Auth(format!("invalid auth file: {err}")))?;
    if payload.provider != PROVIDER_ID || payload.auth_mode != "api_key" {
        return Ok(None);
    }
    let api_key = payload.tokens.api_key.trim();
    if api_key.is_empty() {
        return Ok(None);
    }
    Ok(Some(api_key.to_string()))
}

pub fn save_default_api_key(api_key: &str) -> Result<MistralAuthStatus> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::Auth("Mistral API key cannot be empty".into()));
    }
    let auth = StoredAuth {
        provider: PROVIDER_ID.into(),
        auth_mode: "api_key".into(),
        tokens: StoredTokens {
            api_key: api_key.to_string(),
            ..Default::default()
        },
        last_refresh_ms: None,
        last_validated_ms: Some(now_ms()),
    };
    write_auth_file(&default_auth_path()?, &auth)?;
    Ok(status_from_auth(&auth))
}

pub fn touch_default_auth_validation() -> Result<MistralAuthStatus> {
    let path = default_auth_path()?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MistralAuthStatus::disconnected())
        }
        Err(err) => return Err(AppError::Auth(format!("unable to read auth file: {err}"))),
    };
    let mut auth: StoredAuth = serde_json::from_slice(&bytes)
        .map_err(|err| AppError::Auth(format!("invalid auth file: {err}")))?;
    auth.last_validated_ms = Some(now_ms());
    write_auth_file(&path, &auth)?;
    Ok(status_from_auth(&auth))
}

pub fn load_default_auth_status() -> Result<MistralAuthStatus> {
    load_auth_status(&default_auth_path()?)
}

pub fn load_auth_status(path: &Path) -> Result<MistralAuthStatus> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MistralAuthStatus::disconnected())
        }
        Err(err) => return Err(AppError::Auth(format!("unable to read auth file: {err}"))),
    };
    let payload: StoredAuth = serde_json::from_slice(&bytes)
        .map_err(|err| AppError::Auth(format!("invalid auth file: {err}")))?;
    Ok(status_from_auth(&payload))
}

pub fn delete_default_auth() -> Result<()> {
    let path = default_auth_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppError::Auth(format!("unable to delete auth file: {err}"))),
    }
}

pub fn default_auth_path() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("dev", "williampeynichou", "claakecode")
        .ok_or_else(|| AppError::Auth("unable to resolve local data directory".into()))?;
    Ok(dirs.data_local_dir().join("mistral-auth.json"))
}

fn persist_refresh(path: &Path, access: &str, refresh: &str, expires_at_ms: i64) -> Result<()> {
    let bytes = std::fs::read(path)
        .map_err(|err| AppError::Auth(format!("unable to re-read auth file: {err}")))?;
    let mut root: StoredAuth = serde_json::from_slice(&bytes)
        .map_err(|err| AppError::Auth(format!("unable to parse auth file: {err}")))?;

    root.tokens.access_token = access.to_string();
    if !refresh.is_empty() {
        root.tokens.refresh_token = refresh.to_string();
    }
    root.tokens.expires_at_ms = Some(expires_at_ms);
    root.last_refresh_ms = Some(now_ms());

    write_auth_file(path, &root)
}

fn status_from_auth(auth: &StoredAuth) -> MistralAuthStatus {
    if auth.provider != PROVIDER_ID {
        return MistralAuthStatus::disconnected();
    }
    match auth.auth_mode.as_str() {
        "oauth" => MistralAuthStatus {
            connected: !auth.tokens.access_token.is_empty(),
            auth_mode: Some("oauth".into()),
            key_preview: None,
            expires_at_ms: auth.tokens.expires_at_ms,
            last_refresh_ms: auth.last_refresh_ms,
            last_validated_ms: auth.last_validated_ms,
        },
        "api_key" => {
            let api_key = auth.tokens.api_key.trim();
            MistralAuthStatus {
                connected: !api_key.is_empty(),
                auth_mode: Some("api_key".into()),
                key_preview: (!api_key.is_empty()).then(|| key_preview(api_key)),
                expires_at_ms: None,
                last_refresh_ms: None,
                last_validated_ms: auth.last_validated_ms,
            }
        }
        _ => MistralAuthStatus::disconnected(),
    }
}

fn key_preview(api_key: &str) -> String {
    let chars = api_key.chars().collect::<Vec<_>>();
    if chars.len() <= 12 {
        return "••••".to_string();
    }
    let prefix = chars.iter().take(6).collect::<String>();
    let suffix = chars
        .iter()
        .rev()
        .take(4)
        .copied()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    format!("{prefix}…{suffix}")
}

fn write_auth_file(path: &Path, auth: &StoredAuth) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| AppError::Auth(format!("unable to create auth directory: {err}")))?;
    }
    let pretty = serde_json::to_vec_pretty(auth)
        .map_err(|err| AppError::Decode(format!("unable to serialize auth file: {err}")))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, pretty)
        .map_err(|err| AppError::Auth(format!("unable to write temp auth file: {err}")))?;
    apply_permissions(&temp)?;
    std::fs::rename(&temp, path)
        .map_err(|err| AppError::Auth(format!("unable to replace auth file: {err}")))?;
    Ok(())
}

#[cfg(unix)]
fn apply_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|err| AppError::Auth(format!("unable to chmod auth file: {err}")))?;
    Ok(())
}

#[cfg(not(unix))]
fn apply_permissions(_path: &Path) -> Result<()> {
    Ok(())
}
