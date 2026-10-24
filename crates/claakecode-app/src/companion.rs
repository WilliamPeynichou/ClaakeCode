//! Compagnon Claaky2D : historique propre au compagnon et tour Ask autonome.
//!
//! Le compagnon n'utilise ni workspace, ni outils : il appelle directement un provider déjà
//! configuré et persiste ses conversations dans une table séparée de l'historique principal.
//! Les types sérialisés (camelCase) correspondent à `src/components/companion/companionContract.ts`.

use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use claakecode_core::{ChatMessage, ModelRef, Part, Provider, ProviderRequest, Role, StreamEvent};
use futures_util::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

use crate::store::AppStore;

/// Clé app_settings des réglages du compagnon (écrite par le module des réglages).
pub const COMPANION_SETTINGS_KEY: &str = "companion_settings";

/// Nombre maximal de messages précédents réinjectés dans une requête Ask.
const MAX_HISTORY_MESSAGES: usize = 24;

pub const COMPANION_SYSTEM_PROMPT: &str = r#"Tu es Claaky, le compagnon de bureau de Claake Code.

Mode Ask : tu réponds directement à la demande, sans outils, sans lire de fichiers et sans modifier quoi que ce soit.
- Réponds dans la langue de l'utilisateur, de façon concise et directe.
- Les pièces jointes (images ou textes) sont fournies dans le message : analyse-les ou reformule-les selon la demande.
- Si la demande implique de coder ou de modifier un projet, dis-le en une phrase et propose de passer en mode Code."#;

/// Mode d'un message du compagnon. Ask répond seul ; Code est délégué à Claake Code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CompanionMode {
    #[default]
    Ask,
    Code,
}

/// Pièce jointe : zone d'écran capturée (PNG base64) ou texte collé/joint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CompanionAttachment {
    Image {
        name: String,
        mime: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
    Text {
        name: String,
        text: String,
    },
}

impl CompanionAttachment {
    pub fn name(&self) -> &str {
        match self {
            Self::Image { name, .. } | Self::Text { name, .. } => name,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAskInput {
    /// Absent = nouvelle conversation compagnon.
    #[serde(default)]
    pub conversation_id: Option<String>,
    pub text: String,
    #[serde(default)]
    pub mode: CompanionMode,
    /// « provider:id » ; absent = modèle par défaut des réglages.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub attachments: Vec<CompanionAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAskStarted {
    pub turn_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMessage {
    pub id: String,
    /// "user" ou "assistant".
    pub role: String,
    pub text: String,
    /// Noms des pièces jointes seulement : leur contenu n'est pas persisté.
    #[serde(default)]
    pub attachment_names: Vec<String>,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionConversation {
    pub id: String,
    pub title: String,
    pub updated_at_ms: i64,
    /// « provider:id » utilisé pour la dernière réponse.
    pub model: String,
    pub messages: Vec<CompanionMessage>,
}

/// Événement `companion-turn`. `kind` vaut "delta", "finished" ou "error".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionTurnEvent {
    pub turn_id: String,
    pub conversation_id: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Historique (table propre au compagnon, créée à la volée : pas de migration du store)
// ---------------------------------------------------------------------------

fn ensure_companion_table(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "create table if not exists companion_conversations (
            id text primary key,
            title text not null,
            model text not null,
            messages_json text not null,
            created_at_ms integer not null,
            updated_at_ms integer not null
        );
        create index if not exists idx_companion_conversations_updated
            on companion_conversations(updated_at_ms desc);",
    )
    .context("unable to prepare companion history table")
}

pub fn companion_history_list(store: &AppStore) -> Result<Vec<CompanionConversationSummary>> {
    let conn = store.connection()?;
    ensure_companion_table(&conn)?;
    let mut statement = conn.prepare(
        "select id, title, updated_at_ms from companion_conversations
         order by updated_at_ms desc limit 200",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(CompanionConversationSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                updated_at_ms: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn companion_history_load(store: &AppStore, id: &str) -> Result<Option<CompanionConversation>> {
    let conn = store.connection()?;
    ensure_companion_table(&conn)?;
    let row = conn
        .query_row(
            "select id, title, model, messages_json, updated_at_ms from companion_conversations where id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((id, title, model, messages_json, updated_at_ms)) = row else {
        return Ok(None);
    };
    let messages = serde_json::from_str::<Vec<CompanionMessage>>(&messages_json)
        .context("companion conversation is corrupted")?;
    Ok(Some(CompanionConversation {
        id,
        title,
        model,
        messages,
        updated_at_ms,
    }))
}

pub fn companion_history_save(store: &AppStore, conversation: &CompanionConversation) -> Result<()> {
    let conn = store.connection()?;
    ensure_companion_table(&conn)?;
    let messages_json = serde_json::to_string(&conversation.messages)?;
    let created_at_ms = conversation
        .messages
        .first()
        .map(|message| message.created_at_ms)
        .unwrap_or(conversation.updated_at_ms);
    conn.execute(
        "insert into companion_conversations (id, title, model, messages_json, created_at_ms, updated_at_ms)
         values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict(id) do update set
            title = excluded.title,
            model = excluded.model,
            messages_json = excluded.messages_json,
            updated_at_ms = excluded.updated_at_ms",
        params![
            conversation.id,
            conversation.title,
            conversation.model,
            messages_json,
            created_at_ms,
            conversation.updated_at_ms
        ],
    )
    .context("unable to save companion conversation")?;
    Ok(())
}

pub fn companion_history_delete(store: &AppStore, id: &str) -> Result<()> {
    let conn = store.connection()?;
    ensure_companion_table(&conn)?;
    conn.execute("delete from companion_conversations where id = ?1", params![id])
        .context("unable to delete companion conversation")?;
    Ok(())
}

/// Réglages du compagnon (JSON stocké dans app_settings), s'il existe et se lit.
pub fn companion_settings_json(store: &AppStore) -> Option<Value> {
    let conn = store.connection().ok()?;
    let json = conn
        .query_row(
            "select value_json from app_settings where key = ?1",
            params![COMPANION_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()?;
    serde_json::from_str(&json).ok()
}

/// Modèle par défaut (`defaultModel`) des réglages, s'il est renseigné.
pub fn companion_default_model_setting(settings: Option<&Value>) -> Option<String> {
    settings?
        .get("defaultModel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
}

/// Liste blanche (`allowedModels`) : vide ou absente = tous les modèles configurés.
pub fn companion_allowed_models_setting(settings: Option<&Value>) -> Vec<String> {
    settings
        .and_then(|value| value.get("allowedModels"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Requête Ask
// ---------------------------------------------------------------------------

/// « provider:id » -> ModelRef. Le provider n'a pas de « : », l'id peut en contenir.
pub fn parse_companion_model(value: &str) -> Result<ModelRef> {
    let (provider, name) = value
        .split_once(':')
        .ok_or_else(|| anyhow!("modèle invalide : attendu « provider:id »"))?;
    let (provider, name) = (provider.trim(), name.trim());
    if provider.is_empty() || name.is_empty() {
        bail!("modèle invalide : attendu « provider:id »");
    }
    Ok(ModelRef::new(provider, name))
}

pub fn companion_model_value(model: &ModelRef) -> String {
    format!("{}:{}", model.provider, model.name)
}

/// Texte d'une pièce jointe texte, encadré pour que le modèle le distingue de la demande.
fn text_attachment_block(name: &str, text: &str) -> String {
    format!("\n\n[Pièce jointe : {name}]\n{text}\n[Fin de la pièce jointe]")
}

/// Construit la requête Ask : historique texte borné + message courant (texte et pièces jointes).
pub fn companion_provider_request(
    model: ModelRef,
    history: &[CompanionMessage],
    text: &str,
    attachments: &[CompanionAttachment],
) -> ProviderRequest {
    let mut transcript: Vec<ChatMessage> = history
        .iter()
        .filter(|message| message.error.is_none() && !message.text.trim().is_empty())
        .rev()
        .take(MAX_HISTORY_MESSAGES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| {
            if message.role == "assistant" {
                ChatMessage::assistant_text(message.text.clone())
            } else {
                ChatMessage::user_text(message.text.clone())
            }
        })
        .collect();

    let mut user_text = text.to_string();
    let mut images = Vec::new();
    for attachment in attachments {
        match attachment {
            CompanionAttachment::Text { name, text } => {
                user_text.push_str(&text_attachment_block(name, text));
            }
            CompanionAttachment::Image {
                mime, data_base64, ..
            } => images.push(Part::Image {
                media_type: mime.clone(),
                data: data_base64.clone(),
                meta: None,
            }),
        }
    }
    let mut parts = vec![Part::Text {
        text: user_text,
        meta: None,
    }];
    parts.extend(images);
    transcript.push(ChatMessage {
        role: Role::User,
        parts,
    });

    ProviderRequest::new(model, transcript).with_system(COMPANION_SYSTEM_PROMPT)
}

/// Titre court d'une conversation, dérivé de la première demande.
pub fn companion_title_from(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title: String = flat.chars().take(60).collect();
    if flat.chars().count() > 60 {
        title.push('…');
    }
    if title.is_empty() {
        "Nouvelle conversation".to_string()
    } else {
        title
    }
}

pub fn companion_new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn companion_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn companion_message(role: &str, text: String, attachment_names: Vec<String>) -> CompanionMessage {
    CompanionMessage {
        id: companion_new_id(),
        role: role.to_string(),
        text,
        attachment_names,
        created_at_ms: companion_now_ms(),
        error: None,
    }
}

/// Résultat d'un flux Ask : texte accumulé, et `cancelled` si l'utilisateur a interrompu.
#[derive(Debug, Clone)]
pub struct CompanionStreamOutcome {
    pub text: String,
    pub cancelled: bool,
}

/// Consomme le flux d'un provider pour une requête Ask. `on_delta` reçoit chaque fragment de
/// texte ; `cancel` interrompt le flux et renvoie le texte déjà reçu.
pub async fn run_companion_stream(
    provider: Arc<dyn Provider>,
    request: ProviderRequest,
    cancel: Arc<Notify>,
    mut on_delta: impl FnMut(&str) + Send,
) -> Result<CompanionStreamOutcome> {
    let mut stream = provider
        .stream(request)
        .await
        .context("le modèle n'a pas pu démarrer la réponse")?;
    let mut text = String::new();
    loop {
        tokio::select! {
            biased;
            _ = cancel.notified() => {
                return Ok(CompanionStreamOutcome { text, cancelled: true });
            }
            event = stream.next() => {
                let Some(event) = event else {
                    return Ok(CompanionStreamOutcome { text, cancelled: false });
                };
                match event.map_err(|err| anyhow!(err.to_string()))? {
                    StreamEvent::TextDelta { delta, .. } => {
                        on_delta(&delta);
                        text.push_str(&delta);
                    }
                    StreamEvent::MessageStop { .. } => {
                        return Ok(CompanionStreamOutcome { text, cancelled: false });
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Encode une image PNG en base64 (utilisé par la capture de zone).
pub fn companion_png_base64(bytes: &[u8]) -> String {
    BASE64_STANDARD.encode(bytes)
}
