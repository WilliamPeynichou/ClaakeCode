//! Commandes Tauri de la bulle de chat du compagnon : tour Ask autonome (sans Claake Code ni
//! workspace), annulation, historique propre au compagnon et capture d'une zone d'écran.

use std::{collections::HashMap, sync::Arc};

use claakecode_app::companion::{
    companion_allowed_models_setting, companion_default_model_setting,
    companion_history_delete as delete_history, companion_history_list as list_history,
    companion_history_load as load_history, companion_history_save as save_history,
    companion_message, companion_model_value, companion_new_id, companion_now_ms,
    companion_png_base64, companion_provider_request, companion_settings_json,
    companion_title_from, parse_companion_model, run_companion_stream, CompanionAskInput,
    CompanionAskStarted, CompanionAttachment, CompanionConversation,
    CompanionConversationSummary, CompanionMode, CompanionTurnEvent,
};
use claakecode_core::ModelRef;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use crate::{provider_from_registry, DesktopState};

/// Label de la fenêtre compagnon (contrat companionContract.ts).
const COMPANION_WINDOW_LABEL: &str = "claaky-companion";
const TURN_EVENT: &str = "companion-turn";
const STATE_EVENT: &str = "companion-state";

/// Tours Ask en cours : turnId -> signal d'annulation.
type ActiveCompanionTurns = Arc<std::sync::Mutex<HashMap<String, Arc<Notify>>>>;

fn active_turns() -> &'static ActiveCompanionTurns {
    static TURNS: std::sync::OnceLock<ActiveCompanionTurns> = std::sync::OnceLock::new();
    TURNS.get_or_init(|| Arc::new(std::sync::Mutex::new(HashMap::new())))
}

/// Pose de Claaky pour la fenêtre compagnon. Émis uniquement vers la fenêtre compagnon.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CompanionStatePayload {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
}

fn emit_companion_state(app: &AppHandle, state: &'static str, turn_id: Option<&str>) {
    let _ = app.emit_to(
        COMPANION_WINDOW_LABEL,
        STATE_EVENT,
        CompanionStatePayload {
            state,
            turn_id: turn_id.map(str::to_string),
        },
    );
}

fn emit_turn(app: &AppHandle, event: &CompanionTurnEvent) {
    let _ = app.emit_to(COMPANION_WINDOW_LABEL, TURN_EVENT, event);
}

/// Choisit le modèle d'un tour : demandé > défaut des réglages > premier modèle autorisé.
/// Un modèle hors liste blanche est refusé quand la liste est renseignée.
fn resolve_model(
    state: &DesktopState,
    requested: Option<&str>,
) -> std::result::Result<ModelRef, String> {
    let settings = companion_settings_json(&state.store);
    let allowed = companion_allowed_models_setting(settings.as_ref());
    let chosen = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| companion_default_model_setting(settings.as_ref()))
        .or_else(|| allowed.first().cloned())
        .unwrap_or_else(|| companion_model_value(&state.default_model));
    if !allowed.is_empty() && !allowed.contains(&chosen) {
        return Err("ce modèle n'est pas autorisé dans les réglages du compagnon".into());
    }
    parse_companion_model(&chosen).map_err(|err| err.to_string())
}

/// Tour Ask : construit la requête, lance le flux en tâche de fond et renvoie son identifiant.
/// Le texte arrive ensuite via `companion-turn` ; l'état de Claaky via `companion-state`.
pub(crate) async fn start_companion_ask(
    app: &AppHandle,
    state: &DesktopState,
    input: CompanionAskInput,
) -> std::result::Result<CompanionAskStarted, String> {
    if input.mode == CompanionMode::Code {
        return Err("le mode code passe par Claake Code (companion_forward_to_claake_code)".into());
    }
    let text = input.text.trim().to_string();
    if text.is_empty() && input.attachments.is_empty() {
        return Err("le message est vide".into());
    }
    let model = resolve_model(state, input.model.as_deref())?;
    let provider = provider_from_registry(state, &model.provider)?;

    let mut conversation = match input.conversation_id.as_deref() {
        Some(id) => load_history(&state.store, id)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "conversation compagnon introuvable".to_string())?,
        None => CompanionConversation {
            id: companion_new_id(),
            title: companion_title_from(&text),
            updated_at_ms: companion_now_ms(),
            model: companion_model_value(&model),
            messages: Vec::new(),
        },
    };

    let attachment_names: Vec<String> = input
        .attachments
        .iter()
        .map(|attachment| attachment.name().to_string())
        .collect();
    let request = companion_provider_request(
        model.clone(),
        &conversation.messages,
        &text,
        &input.attachments,
    );
    let user_message = companion_message("user", text.clone(), attachment_names);
    conversation.messages.push(user_message);
    conversation.model = companion_model_value(&model);
    conversation.updated_at_ms = companion_now_ms();
    save_history(&state.store, &conversation).map_err(|err| err.to_string())?;

    let turn_id = companion_new_id();
    let conversation_id = conversation.id.clone();
    let cancel = Arc::new(Notify::new());
    active_turns()
        .lock()
        .map_err(|_| "companion turns are unavailable".to_string())?
        .insert(turn_id.clone(), cancel.clone());

    let app_task = app.clone();
    let turn_id_task = turn_id.clone();
    let conversation_task = conversation_id.clone();
    tauri::async_runtime::spawn(async move {
        emit_companion_state(&app_task, "thinking", Some(&turn_id_task));
        let delta_app = app_task.clone();
        let delta_turn = turn_id_task.clone();
        let delta_conversation = conversation_task.clone();
        let outcome = run_companion_stream(provider, request, cancel, move |delta| {
            emit_turn(
                &delta_app,
                &CompanionTurnEvent {
                    turn_id: delta_turn.clone(),
                    conversation_id: delta_conversation.clone(),
                    kind: "delta",
                    text: Some(delta.to_string()),
                    error: None,
                },
            );
        })
        .await;

        if let Some(state) = app_task.try_state::<DesktopState>() {
            let store = &state.store;
            let _ = active_turns()
                .lock()
                .map(|mut turns| turns.remove(&turn_id_task));
            match outcome {
                Ok(done) => {
                    let mut conversation = load_history(store, &conversation_task)
                        .ok()
                        .flatten()
                        .unwrap_or(conversation);
                    if !done.text.is_empty() || !done.cancelled {
                        conversation.messages.push(companion_message(
                            "assistant",
                            done.text,
                            Vec::new(),
                        ));
                    }
                    conversation.updated_at_ms = companion_now_ms();
                    let _ = save_history(store, &conversation);
                    emit_turn(
                        &app_task,
                        &CompanionTurnEvent {
                            turn_id: turn_id_task.clone(),
                            conversation_id: conversation_task.clone(),
                            kind: "finished",
                            text: None,
                            error: None,
                        },
                    );
                    emit_companion_state(&app_task, "done", Some(&turn_id_task));
                }
                Err(err) => {
                    let message = err.to_string();
                    emit_turn(
                        &app_task,
                        &CompanionTurnEvent {
                            turn_id: turn_id_task.clone(),
                            conversation_id: conversation_task.clone(),
                            kind: "error",
                            text: None,
                            error: Some(message),
                        },
                    );
                    emit_companion_state(&app_task, "error", Some(&turn_id_task));
                }
            }
        }
    });

    Ok(CompanionAskStarted {
        turn_id,
        conversation_id,
    })
}

#[tauri::command]
pub(super) async fn companion_ask(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: CompanionAskInput,
) -> std::result::Result<CompanionAskStarted, String> {
    start_companion_ask(&app, &state, input).await
}

#[tauri::command]
pub(super) fn companion_cancel(turn_id: String) -> std::result::Result<(), String> {
    let cancel = active_turns()
        .lock()
        .map_err(|_| "companion turns are unavailable".to_string())?
        .get(&turn_id)
        .cloned();
    if let Some(cancel) = cancel {
        // notify_one garde la permission si le flux n'attend pas encore.
        cancel.notify_one();
    }
    Ok(())
}

#[tauri::command]
pub(super) fn companion_history_list(
    state: State<'_, DesktopState>,
) -> std::result::Result<Vec<CompanionConversationSummary>, String> {
    list_history(&state.store).map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn companion_history_load(
    state: State<'_, DesktopState>,
    id: String,
) -> std::result::Result<CompanionConversation, String> {
    load_history(&state.store, &id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "conversation compagnon introuvable".to_string())
}

#[tauri::command]
pub(super) fn companion_history_delete(
    state: State<'_, DesktopState>,
    id: String,
) -> std::result::Result<(), String> {
    delete_history(&state.store, &id).map_err(|err| err.to_string())
}

/// Capture d'une zone de l'écran : délègue à l'outil système `screencapture -i` (sélection
/// interactive). Renvoie `None` si l'utilisateur annule (Échap ou fichier vide).
#[tauri::command]
pub(super) async fn companion_capture_region() -> std::result::Result<Option<CompanionAttachment>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Err("la capture de zone est disponible sur macOS pour l'instant".into());
    }
    #[cfg(target_os = "macos")]
    {
        let path = std::env::temp_dir().join(format!("claaky-capture-{}.png", companion_new_id()));
        let status = tokio::process::Command::new("screencapture")
            .arg("-i")
            .arg("-x")
            .arg("-t")
            .arg("png")
            .arg(&path)
            .status()
            .await
            .map_err(|err| format!("capture impossible : {err}"))?;
        if !status.success() {
            let _ = std::fs::remove_file(&path);
            return Ok(None);
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(None),
        };
        let _ = std::fs::remove_file(&path);
        if bytes.is_empty() {
            return Ok(None);
        }
        Ok(Some(CompanionAttachment::Image {
            name: "zone-capturée.png".into(),
            mime: "image/png".into(),
            data_base64: companion_png_base64(&bytes),
        }))
    }
}
