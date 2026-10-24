//! Points d'entrée du compagnon Claaky2D : réglages persistés, raccourci global, icône de barre
//! des menus, lancement au démarrage de la session, transfert d'une tâche code vers Claake Code
//! (ouverture automatique si besoin) et garde de sortie pour que Claaky reste présent quand la
//! fenêtre principale est fermée.
use std::{str::FromStr, sync::Mutex};

use anyhow::{anyhow, Result};
use claakecode_app::companion::{
    companion_history_load, CompanionAskInput, CompanionAttachment, CompanionConversation,
    CompanionMode,
};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::companion_window;
use crate::platform::{create_new_window, error_to_string};
use crate::state::DesktopState;

/// Clés app_settings (contrat companionContract.ts).
const COMPANION_SETTINGS_KEY: &str = "companion_settings";
/// Raccourci global par défaut : Contrôle + Option + Espace (libre : Option + Espace est pris par
/// ChatGPT, Contrôle + Espace par le changement de source de saisie).
const DEFAULT_SHORTCUT: &str = "Control+Alt+Space";
/// Ancien défaut, migré automatiquement vers le nouveau.
const LEGACY_SHORTCUT: &str = "Alt+Space";
/// Noms d'événements (contrat COMPANION_EVENTS).
const SETTINGS_CHANGED_EVENT: &str = "companion-settings-changed";
const FORWARD_TASK_EVENT: &str = "companion-forward-task";
const CONTINUE_REQUESTED_EVENT: &str = "companion-continue-requested";

const TRAY_ID: &str = "claaky-companion-tray";
const TRAY_TOGGLE_ID: &str = "companion-tray-toggle";
const TRAY_OPEN_ID: &str = "companion-tray-open-claake-code";
const TRAY_QUIT_ID: &str = "companion-tray-quit";

/// États Claaky acceptés par companion_report_state (ClaakyState du front).
const CLAAKY_STATES: [&str; 7] = [
    "idle", "thinking", "working", "planning", "done", "error", "sleeping",
];

/// Réglages du compagnon (contrat CompanionSettings, camelCase).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct CompanionSettings {
    pub shortcut: String,
    pub default_mode: CompanionMode,
    pub allowed_models: Vec<String>,
    pub default_model: Option<String>,
    pub launch_at_login: bool,
}

impl Default for CompanionSettings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.into(),
            default_mode: CompanionMode::Ask,
            allowed_models: Vec::new(),
            default_model: None,
            launch_at_login: false,
        }
    }
}

/// Tâche code en attente de prise en charge par une fenêtre Claake Code (contrat CompanionPendingForward).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompanionPendingForward {
    pub text: String,
    pub attachments: Vec<CompanionAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_conversation_id: Option<String>,
}

/// Raccourci actuellement enregistré (pour le désenregistrer lors d'un changement).
#[derive(Default)]
pub(crate) struct CompanionShortcutSlot(Mutex<Option<String>>);

/// Une seule tâche en attente à la fois ; la première fenêtre qui la réclame la consomme.
#[derive(Default)]
pub(crate) struct CompanionPendingSlot(Mutex<Option<CompanionPendingForward>>);

/// Vérifie et nettoie les réglages reçus du front.
fn normalize_settings(mut settings: CompanionSettings) -> Result<CompanionSettings> {
    let shortcut = settings.shortcut.trim().to_string();
    if shortcut.is_empty() {
        return Err(anyhow!("le raccourci est vide"));
    }
    Shortcut::from_str(&shortcut).map_err(|err| anyhow!("raccourci invalide : {err}"))?;
    settings.shortcut = shortcut;

    let mut models: Vec<String> = Vec::new();
    for model in settings.allowed_models.iter().map(|m| m.trim()) {
        if !model.is_empty() && !models.iter().any(|known| known == model) {
            models.push(model.to_string());
        }
    }
    settings.allowed_models = models;

    settings.default_model = settings
        .default_model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .filter(|m| settings.allowed_models.is_empty() || settings.allowed_models.contains(m));
    Ok(settings)
}

fn load_settings(app: &AppHandle) -> Result<CompanionSettings> {
    let state = app.state::<DesktopState>();
    let mut settings = state
        .store
        .load_json_setting::<CompanionSettings>(COMPANION_SETTINGS_KEY)?
        .unwrap_or_default();
    if settings.shortcut == LEGACY_SHORTCUT {
        settings.shortcut = DEFAULT_SHORTCUT.into();
    }
    Ok(settings)
}

/// Enregistre le raccourci global. Le nouveau est posé avant de retirer l'ancien, pour ne jamais
/// rester sans raccourci si la nouvelle combinaison est refusée par le système.
fn apply_shortcut(app: &AppHandle, shortcut: &str) -> Result<()> {
    let slot = app.state::<CompanionShortcutSlot>();
    let mut current = slot
        .0
        .lock()
        .map_err(|_| anyhow!("verrou du raccourci indisponible"))?;
    if current.as_deref() == Some(shortcut) {
        return Ok(());
    }
    let global = app.global_shortcut();
    global
        .register(shortcut)
        .map_err(|err| anyhow!("impossible d'enregistrer le raccourci {shortcut} : {err}"))?;
    if let Some(previous) = current.take() {
        let _ = global.unregister(previous.as_str());
    }
    *current = Some(shortcut.to_string());
    Ok(())
}

/// Raccourci pressé : ouvre ou ferme la bulle de Claaky.
fn on_shortcut(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if matches!(event.state(), ShortcutState::Pressed) {
        if let Err(err) = companion_window::toggle_bubble(app) {
            tracing::warn!(error = %err, "companion shortcut toggle failed");
        }
    }
}

fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<()> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable()?;
    } else if manager.is_enabled().unwrap_or(false) {
        manager.disable()?;
    }
    Ok(())
}

/// Plugin autostart : LaunchAgent sur macOS (lancement à l'ouverture de session).
pub(crate) fn autostart_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None)
}

/// Plugin raccourci global : le gestionnaire est branché une fois, l'enregistrement se fait au démarrage.
pub(crate) fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(on_shortcut)
        .build()
}

fn install_tray(app: &AppHandle) -> Result<()> {
    let toggle =
        MenuItemBuilder::with_id(TRAY_TOGGLE_ID, "Afficher / masquer Claaky").build(app)?;
    let open = MenuItemBuilder::with_id(TRAY_OPEN_ID, "Ouvrir Claake Code").build(app)?;
    let quit = MenuItemBuilder::with_id(TRAY_QUIT_ID, "Quitter Claake Code").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &open, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Claake Code · Claaky")
        .on_menu_event(|app, event| {
            if event.id() == TRAY_TOGGLE_ID {
                if let Err(err) = companion_window::toggle_companion_visibility(app) {
                    tracing::warn!(error = %err, "tray toggle failed");
                }
            } else if event.id() == TRAY_OPEN_ID {
                open_claake_code(app);
            } else if event.id() == TRAY_QUIT_ID {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(err) = companion_window::toggle_bubble(tray.app_handle()) {
                    tracing::warn!(error = %err, "tray click toggle failed");
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Installation au démarrage : raccourci, icône de barre des menus, fenêtre compagnon.
/// Chaque étape est tolérante aux pannes : un échec ne bloque pas le lancement de l'app.
pub(crate) fn setup(app: &AppHandle) -> Result<()> {
    app.manage(CompanionShortcutSlot::default());
    app.manage(CompanionPendingSlot::default());

    let settings = match load_settings(app) {
        Ok(settings) => settings,
        Err(err) => {
            tracing::warn!(error = %err, "companion settings unreadable, using defaults");
            CompanionSettings::default()
        }
    };
    if let Err(err) = apply_shortcut(app, &settings.shortcut) {
        tracing::warn!(error = %err, "companion shortcut unavailable");
    }
    if let Err(err) = install_tray(app) {
        tracing::warn!(error = %err, "companion tray unavailable");
    }
    if let Err(err) = companion_window::ensure_companion_window(app) {
        tracing::warn!(error = %err, "companion window unavailable");
    }
    Ok(())
}

/// Garde de sortie : quand la dernière fenêtre disparaît (fenêtre principale fermée alors que
/// Claaky est toujours là), Tauri demande une sortie sans code. On refuse : Claaky et le mode Ask
/// restent actifs. Les sorties explicites (Quitter de la barre des menus, Cmd+Q) passent avec un code.
pub(crate) fn keep_alive_without_windows(event: &tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested {
        code: None, api, ..
    } = event
    {
        api.prevent_exit();
    }
}

/// Ouvre Claake Code : montre une fenêtre existante (hors compagnon) ou en crée une.
fn open_claake_code(app: &AppHandle) {
    let target = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.as_str() != companion_window::COMPANION_WINDOW_LABEL)
        .map(|(_, window)| window)
        .next();
    match target {
        Some(window) => {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        None => {
            if let Err(err) = create_new_window(app) {
                tracing::warn!(error = %err, "unable to open Claake Code window");
            }
        }
    }
}

/// Pose une tâche en attente puis la diffuse. Les fenêtres la réclament via companion_take_pending_forward.
fn queue_forward(
    app: &AppHandle,
    pending: CompanionPendingForward,
    event: &str,
) -> Result<(), String> {
    app.state::<CompanionPendingSlot>().put(pending.clone())?;
    app.emit(event, &pending).map_err(error_to_string)
}

#[tauri::command]
pub(crate) fn companion_get_settings(
    state: State<'_, DesktopState>,
) -> std::result::Result<CompanionSettings, String> {
    let settings = state
        .store
        .load_json_setting::<CompanionSettings>(COMPANION_SETTINGS_KEY)
        .map_err(error_to_string)?;
    Ok(settings.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn companion_save_settings(
    app: AppHandle,
    state: State<'_, DesktopState>,
    settings: CompanionSettings,
) -> std::result::Result<CompanionSettings, String> {
    let settings = normalize_settings(settings).map_err(error_to_string)?;
    apply_shortcut(&app, &settings.shortcut).map_err(error_to_string)?;
    apply_autostart(&app, settings.launch_at_login).map_err(error_to_string)?;
    state
        .store
        .save_json_setting(COMPANION_SETTINGS_KEY, &settings)
        .map_err(error_to_string)?;
    let _ = app.emit(SETTINGS_CHANGED_EVENT, &settings);
    Ok(settings)
}

/// Mode code : ouvre Claake Code si besoin, puis transmet la demande au projet ouvert.
#[tauri::command]
pub(crate) fn companion_forward_to_claake_code(
    app: AppHandle,
    input: CompanionAskInput,
) -> std::result::Result<(), String> {
    let pending = forward_from_input(input)?;
    queue_forward(&app, pending, FORWARD_TASK_EVENT)?;
    open_claake_code(&app);
    Ok(())
}

/// Valide une demande du mode code et la convertit en tâche à transmettre.
fn forward_from_input(
    input: CompanionAskInput,
) -> std::result::Result<CompanionPendingForward, String> {
    if !matches!(input.mode, CompanionMode::Code) {
        return Err("le transfert vers Claake Code exige le mode code".into());
    }
    let text = input.text.trim().to_string();
    if text.is_empty() && input.attachments.is_empty() {
        return Err("la tâche est vide".into());
    }
    Ok(CompanionPendingForward {
        text,
        attachments: input.attachments,
        model: input.model,
        source_conversation_id: input.conversation_id,
    })
}

/// Tâche de reprise d'une conversation compagnon dans Claake Code.
fn forward_from_conversation(conversation: &CompanionConversation) -> CompanionPendingForward {
    CompanionPendingForward {
        text: continuation_prompt(conversation),
        attachments: Vec::new(),
        model: Some(conversation.model.clone()),
        source_conversation_id: Some(conversation.id.clone()),
    }
}

impl CompanionPendingSlot {
    fn put(&self, pending: CompanionPendingForward) -> std::result::Result<(), String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "verrou de la tâche indisponible".to_string())?;
        *guard = Some(pending);
        Ok(())
    }

    fn take(&self) -> std::result::Result<Option<CompanionPendingForward>, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "verrou de la tâche indisponible".to_string())?;
        Ok(guard.take())
    }
}

#[tauri::command]
pub(crate) fn companion_take_pending_forward(
    slot: State<'_, CompanionPendingSlot>,
) -> std::result::Result<Option<CompanionPendingForward>, String> {
    slot.take()
}

#[tauri::command]
pub(crate) fn companion_open_claake_code(app: AppHandle) -> std::result::Result<(), String> {
    open_claake_code(&app);
    Ok(())
}

/// Reprise d'une conversation compagnon dans Claake Code : même canal que le transfert de tâche.
#[tauri::command]
pub(crate) fn companion_continue_in_app(
    app: AppHandle,
    state: State<'_, DesktopState>,
    conversation_id: String,
) -> std::result::Result<(), String> {
    let conversation = companion_history_load(&state.store, &conversation_id)
        .map_err(error_to_string)?
        .ok_or_else(|| "conversation compagnon introuvable".to_string())?;
    let pending = forward_from_conversation(&conversation);
    queue_forward(&app, pending, CONTINUE_REQUESTED_EVENT)?;
    open_claake_code(&app);
    Ok(())
}

/// Pose de Claaky relayée par la fenêtre principale (ex. tâche code en cours).
#[tauri::command]
pub(crate) fn companion_report_state(
    app: AppHandle,
    state: String,
) -> std::result::Result<(), String> {
    if !CLAAKY_STATES.contains(&state.as_str()) {
        return Err(format!("état Claaky inconnu : {state}"));
    }
    companion_window::emit_companion_state(&app, &state, None);
    Ok(())
}

/// Texte d'amorce pour reprendre une conversation compagnon dans Claake Code.
fn continuation_prompt(conversation: &CompanionConversation) -> String {
    let transcript = conversation
        .messages
        .iter()
        .map(|message| {
            let role = if message.role == "user" {
                "Utilisateur"
            } else {
                "Claaky"
            };
            format!("{role} : {}", message.text.trim())
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "Voici une conversation menée avec le compagnon Claaky (mode Ask). Reprends-la à partir du dernier message et attends ma prochaine demande.\n\n{transcript}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use claakecode_app::companion::CompanionMessage;

    fn input(
        mode: CompanionMode,
        text: &str,
        attachments: Vec<CompanionAttachment>,
    ) -> CompanionAskInput {
        CompanionAskInput {
            conversation_id: Some("conv-1".into()),
            text: text.into(),
            mode,
            model: Some("anthropic:claude".into()),
            attachments,
        }
    }

    fn message(role: &str, text: &str) -> CompanionMessage {
        CompanionMessage {
            id: format!("{role}-{text}"),
            role: role.into(),
            text: text.into(),
            attachment_names: Vec::new(),
            created_at_ms: 1,
            error: None,
        }
    }

    #[test]
    fn forward_rejects_ask_mode() {
        let err = forward_from_input(input(CompanionMode::Ask, "fais X", vec![])).unwrap_err();
        assert!(err.contains("mode code"));
    }

    #[test]
    fn forward_rejects_empty_task() {
        let err = forward_from_input(input(CompanionMode::Code, "   \n", vec![])).unwrap_err();
        assert!(err.contains("vide"));
    }

    #[test]
    fn forward_accepts_attachment_only_and_keeps_context() {
        let attachment = CompanionAttachment::Text {
            name: "note.txt".into(),
            text: "contenu".into(),
        };
        let pending =
            forward_from_input(input(CompanionMode::Code, "  ", vec![attachment])).unwrap();
        assert_eq!(pending.text, "");
        assert_eq!(pending.attachments.len(), 1);
        assert_eq!(pending.model.as_deref(), Some("anthropic:claude"));
        assert_eq!(pending.source_conversation_id.as_deref(), Some("conv-1"));
    }

    #[test]
    fn forward_trims_task_text() {
        let pending =
            forward_from_input(input(CompanionMode::Code, "  corrige le bug \n", vec![])).unwrap();
        assert_eq!(pending.text, "corrige le bug");
    }

    #[test]
    fn pending_slot_is_consumed_once() {
        let slot = CompanionPendingSlot::default();
        assert!(slot.take().unwrap().is_none());
        slot.put(forward_from_input(input(CompanionMode::Code, "a", vec![])).unwrap())
            .unwrap();
        slot.put(forward_from_input(input(CompanionMode::Code, "b", vec![])).unwrap())
            .unwrap();
        assert_eq!(
            slot.take().unwrap().unwrap().text,
            "b",
            "la dernière tâche remplace la précédente"
        );
        assert!(
            slot.take().unwrap().is_none(),
            "une tâche n'est remise qu'à une seule fenêtre"
        );
    }

    #[test]
    fn continuation_carries_transcript_model_and_source() {
        let conversation = CompanionConversation {
            id: "conv-42".into(),
            title: "t".into(),
            updated_at_ms: 2,
            model: "openai:gpt".into(),
            messages: vec![message("user", " Bonjour "), message("assistant", "Salut")],
        };
        let pending = forward_from_conversation(&conversation);
        assert!(pending
            .text
            .ends_with("Utilisateur : Bonjour\n\nClaaky : Salut"));
        assert!(pending.attachments.is_empty());
        assert_eq!(pending.model.as_deref(), Some("openai:gpt"));
        assert_eq!(pending.source_conversation_id.as_deref(), Some("conv-42"));
    }

    #[test]
    fn pending_forward_serializes_camel_case() {
        let pending = forward_from_input(input(CompanionMode::Code, "x", vec![])).unwrap();
        let json = serde_json::to_value(&pending).unwrap();
        assert_eq!(json["sourceConversationId"], "conv-1");
        assert_eq!(json["model"], "anthropic:claude");
    }

    #[test]
    fn settings_normalization() {
        let settings = normalize_settings(CompanionSettings {
            shortcut: "  Control+Alt+Space ".into(),
            allowed_models: vec![" a:1 ".into(), "a:1".into(), "".into(), "b:2".into()],
            default_model: Some("c:3".into()),
            ..CompanionSettings::default()
        })
        .unwrap();
        assert_eq!(settings.shortcut, "Control+Alt+Space");
        assert_eq!(settings.allowed_models, vec!["a:1", "b:2"]);
        assert_eq!(
            settings.default_model, None,
            "modèle par défaut hors liste blanche retiré"
        );
        assert!(normalize_settings(CompanionSettings {
            shortcut: " ".into(),
            ..CompanionSettings::default()
        })
        .is_err());
    }
}
