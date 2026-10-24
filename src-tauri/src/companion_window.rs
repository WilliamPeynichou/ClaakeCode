//! Compagnon Claaky2D sur le bureau : fenêtre transparente, sans décorations, toujours au premier
//! plan. Rust tient la mise en page (bulle ouverte ou fermée) et persiste l'ancre de Claaky : le
//! coin haut-gauche de sa case 120×120 (coordonnées logiques). La bulle s'ouvre sous Claaky ;
//! elle part vers la gauche si Claaky est dans la moitié droite de l'écran (cas courant : en haut à
//! droite), sinon vers la droite. Claaky ne bouge pas, sauf si l'écran l'impose.
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex as StdMutex,
    },
    time::Duration,
};

use crate::*;
use tauri::{
    LogicalPosition, LogicalSize, Monitor, PhysicalPosition, Window, WebviewWindow, WindowEvent,
};

pub(crate) const COMPANION_WINDOW_LABEL: &str = "claaky-companion";
const COMPANION_WINDOW_URL: &str = "index.html?companion=1";
/// Clé app_settings : ancre de Claaky (CompanionPosition { x, y }, logique).
const COMPANION_POSITION_KEY: &str = "companion_position";
/// Événements (contrat companionContract.ts).
const COMPANION_STATE_EVENT: &str = "companion-state";
const COMPANION_BUBBLE_EVENT: &str = "companion-bubble-changed";
/// Pré-transition : le front fondu le contenu AVANT que la géométrie de la fenêtre ne change,
/// pour ne jamais peindre de frame intermédiaire (Claaky qui saute à gauche au clic).
const COMPANION_BUBBLE_FADING_EVENT: &str = "companion-bubble-fading";
/// Case de Claaky = taille de la fenêtre repliée.
const COLLAPSED_SIZE: (f64, f64) = (120.0, 120.0);
/// Taille de la fenêtre quand la bulle est ouverte.
const EXPANDED_SIZE: (f64, f64) = (250.0, 330.0);
/// Durée du fondu CSS côté front (voir .cd[data-fading]) + marge : la géométrie n'est
/// appliquée qu'une fois le contenu totalement transparent.
const GEOMETRY_DELAY_MS: u64 = 150;
/// Marge gardée avec les bords de l'écran.
const SCREEN_MARGIN: f64 = 12.0;
/// Délai avant d'écrire la position (un glissement émet beaucoup d'événements Moved).
const SAVE_DEBOUNCE_MS: u64 = 350;
#[cfg(target_os = "macos")]
const TOP_INSET: f64 = 28.0; // barre des menus
#[cfg(not(target_os = "macos"))]
const TOP_INSET: f64 = 0.0;

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompanionPosition {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

static BUBBLE_OPEN: AtomicBool = AtomicBool::new(false);
/// Bulle ouverte vers la gauche (Claaky collé au bord droit de la fenêtre).
static BUBBLE_TO_LEFT: AtomicBool = AtomicBool::new(true);
/// Génération de la transition en cours : un clic rapide annule la géométrie planifiée
/// de la génération précédente.
static GEOMETRY_GENERATION: AtomicU64 = AtomicU64::new(0);
static SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// Sérialise les déplacements programmés (bulle) pour que les événements Moved restent cohérents.
static LAYOUT_LOCK: StdMutex<()> = StdMutex::new(());

#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn contains(&self, point: (f64, f64)) -> bool {
        point.0 >= self.x
            && point.0 < self.x + self.w
            && point.1 >= self.y
            && point.1 < self.y + self.h
    }
}

const FALLBACK_SCREEN: Rect = Rect {
    x: 0.0,
    y: 0.0,
    w: 1440.0,
    h: 900.0,
};

/// Décalage de la case de Claaky dans la fenêtre : en haut, à droite si la bulle part vers la
/// gauche, sinon à gauche. La bulle occupe l'espace dessous.
fn claaky_offset(open: bool, to_left: bool) -> (f64, f64) {
    if open && to_left {
        (EXPANDED_SIZE.0 - COLLAPSED_SIZE.0, 0.0)
    } else {
        (0.0, 0.0)
    }
}

fn window_size(open: bool) -> (f64, f64) {
    if open {
        EXPANDED_SIZE
    } else {
        COLLAPSED_SIZE
    }
}

fn monitor_rect(monitor: &Monitor) -> Rect {
    let scale = monitor.scale_factor();
    let pos = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    Rect {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
    }
}

/// Écran qui contient le point, sinon le premier écran connu, sinon une zone par défaut.
fn screen_for(window: &WebviewWindow, point: (f64, f64)) -> Rect {
    let rects: Vec<Rect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(monitor_rect)
        .collect();
    rects
        .iter()
        .copied()
        .find(|rect| rect.contains(point))
        .or_else(|| rects.first().copied())
        .unwrap_or(FALLBACK_SCREEN)
}

fn clamp_axis(value: f64, start: f64, length: f64, size: f64) -> f64 {
    let low = start + SCREEN_MARGIN;
    let high = (start + length - size - SCREEN_MARGIN).max(low);
    value.max(low).min(high)
}

/// Garde la fenêtre entière dans l'écran (en dessous de la barre des menus).
fn clamp_origin(origin: (f64, f64), size: (f64, f64), screen: Rect) -> (f64, f64) {
    let top = screen.y + TOP_INSET;
    let height = screen.h - TOP_INSET;
    (
        clamp_axis(origin.0, screen.x, screen.w, size.0),
        clamp_axis(origin.1, top, height, size.1),
    )
}

/// Coin bas-droit de l'écran, au-dessus du Dock.
fn default_anchor_on(screen: Rect) -> (f64, f64) {
    (
        screen.x + screen.w - COLLAPSED_SIZE.0 - 24.0,
        screen.y + screen.h - COLLAPSED_SIZE.1 - 80.0,
    )
}

fn logical_origin(window: &WebviewWindow) -> Result<(f64, f64)> {
    let scale = window
        .scale_factor()
        .context("unable to read scale factor")?;
    let pos = window
        .outer_position()
        .context("unable to read companion position")?
        .to_logical::<f64>(scale);
    Ok((pos.x, pos.y))
}

fn stored_position(app: &AppHandle) -> Option<CompanionPosition> {
    let state = app.try_state::<DesktopState>()?;
    state
        .store
        .load_json_setting::<CompanionPosition>(COMPANION_POSITION_KEY)
        .ok()
        .flatten()
}

/// Enregistre l'ancre après une pause ; la dernière valeur gagne.
fn schedule_position_save(app: &AppHandle, anchor: (f64, f64)) {
    let generation = SAVE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(SAVE_DEBOUNCE_MS));
        if SAVE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let Some(state) = app.try_state::<DesktopState>() else {
            return;
        };
        let position = CompanionPosition {
            x: anchor.0,
            y: anchor.1,
        };
        if let Err(err) = state
            .store
            .save_json_setting(COMPANION_POSITION_KEY, &position)
        {
            tracing::warn!(error = %err, "unable to save companion position");
        }
    });
}

/// Fenêtre compagnon : créée si absente (repliée, à la position mémorisée), sinon renvoyée.
pub(crate) fn ensure_companion_window(app: &AppHandle) -> Result<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window(COMPANION_WINDOW_LABEL) {
        return Ok(window);
    }

    let monitors: Vec<Rect> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(monitor_rect)
        .collect();
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .as_ref()
        .map(monitor_rect)
        .or_else(|| monitors.first().copied())
        .unwrap_or(FALLBACK_SCREEN);
    let anchor = match stored_position(app).map(|p| (p.x, p.y)) {
        // Position mémorisée seulement si elle est encore sur un écran connecté.
        Some(point)
            if monitors.iter().any(|rect| {
                rect.contains((
                    point.0 + COLLAPSED_SIZE.0 / 2.0,
                    point.1 + COLLAPSED_SIZE.1 / 2.0,
                ))
            }) =>
        {
            point
        }
        _ => default_anchor_on(primary),
    };
    let origin = clamp_origin(anchor, COLLAPSED_SIZE, primary);

    let window = WebviewWindowBuilder::new(
        app,
        COMPANION_WINDOW_LABEL,
        WebviewUrl::App(COMPANION_WINDOW_URL.into()),
    )
    .title("Claaky")
    .inner_size(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1)
    .position(origin.0, origin.1)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true)
    .accept_first_mouse(true)
    .focused(false)
    .build()
    .context("unable to create companion window")?;
    Ok(window)
}

pub(crate) fn show_companion_window(app: &AppHandle) -> Result<()> {
    let window = ensure_companion_window(app)?;
    let _ = window.unminimize();
    window.show().context("unable to show companion window")?;
    Ok(())
}

/// Cache Claaky (bulle repliée d'abord). Le raccourci ou la barre des menus le font réapparaître.
pub(crate) fn hide_companion_window(app: &AppHandle) -> Result<()> {
    if BUBBLE_OPEN.load(Ordering::SeqCst) {
        set_bubble_open(app, false)?;
    }
    if let Some(window) = app.get_webview_window(COMPANION_WINDOW_LABEL) {
        window.hide().context("unable to hide companion window")?;
    }
    Ok(())
}

/// Affiche Claaky s'il est caché, sinon le cache.
pub(crate) fn toggle_companion_visibility(app: &AppHandle) -> Result<()> {
    let visible = app
        .get_webview_window(COMPANION_WINDOW_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        hide_companion_window(app)
    } else {
        show_companion_window(app)
    }
}

/// Ouvre ou ferme la bulle. La fenêtre change de taille ; l'ancre de Claaky reste en place
/// Ouvre ou ferme la bulle. La fenêtre change de taille et de position ; l'ancre de Claaky
/// reste en place (écran permettant), puis est enregistrée.
///
/// Déroulé en deux temps pour éviter le flash d'une frame intermédiaire (Claaky peint à
/// gauche de sa position tant que le front n'a pas re-rendu après le déplacement) :
///   1. on émet `companion-bubble-fading` — le front fond le contenu à opacité 0 ;
///   2. après GEOMETRY_DELAY_MS, on applique taille + position puis on émet
///      `companion-bubble-changed` — le front révèle la nouvelle disposition en fondu.
pub(crate) fn set_bubble_open(app: &AppHandle, open: bool) -> Result<()> {
    let window = ensure_companion_window(app)?;
    let _guard = LAYOUT_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let was_open = BUBBLE_OPEN.load(Ordering::SeqCst);
    let origin = logical_origin(&window)?;
    let before = claaky_offset(was_open, BUBBLE_TO_LEFT.load(Ordering::SeqCst));
    let anchor = (origin.0 + before.0, origin.1 + before.1);

    let size = window_size(open);
    let screen = screen_for(
        &window,
        (
            anchor.0 + COLLAPSED_SIZE.0 / 2.0,
            anchor.1 + COLLAPSED_SIZE.1 / 2.0,
        ),
    );
    // À l'ouverture, la bulle part du côté où il y a de la place.
    let to_left = if open {
        anchor.0 + COLLAPSED_SIZE.0 / 2.0 > screen.x + screen.w / 2.0
    } else {
        BUBBLE_TO_LEFT.load(Ordering::SeqCst)
    };
    BUBBLE_TO_LEFT.store(to_left, Ordering::SeqCst);
    let after = claaky_offset(open, to_left);
    let target = clamp_origin((anchor.0 - after.0, anchor.1 - after.1), size, screen);
    let final_anchor = (target.0 + after.0, target.1 + after.1);

    BUBBLE_OPEN.store(open, Ordering::SeqCst);
    let generation = GEOMETRY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let side = if to_left { "left" } else { "right" };
    let payload = serde_json::json!({ "open": open, "side": side });
    let _ = app.emit(COMPANION_BUBBLE_FADING_EVENT, &payload);

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(GEOMETRY_DELAY_MS));
        if GEOMETRY_GENERATION.load(Ordering::SeqCst) != generation {
            return; // une transition plus récente a pris le relais
        }
        let window = match ensure_companion_window(&app) {
            Ok(window) => window,
            Err(err) => {
                tracing::warn!(error = %err, "companion window gone during bubble transition");
                return;
            }
        };
        let _guard = LAYOUT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(err) = window.set_size(LogicalSize::new(size.0, size.1)) {
            tracing::warn!(error = %err, "unable to resize companion window");
        }
        if let Err(err) = window.set_position(LogicalPosition::new(target.0, target.1)) {
            tracing::warn!(error = %err, "unable to move companion window");
        }
        schedule_position_save(&app, final_anchor);
        let _ = app.emit(COMPANION_BUBBLE_EVENT, &payload);
    });
    Ok(())
}

pub(crate) fn toggle_bubble(app: &AppHandle) -> Result<()> {
    let open = BUBBLE_OPEN.load(Ordering::SeqCst);
    let visible = app
        .get_webview_window(COMPANION_WINDOW_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    // Claaky caché : le raccourci le fait réapparaître avec la bulle ouverte.
    if !visible {
        show_companion_window(app)?;
        return set_bubble_open(app, true);
    }
    set_bubble_open(app, !open)
}

/// Pose de Claaky pour la fenêtre compagnon (7 états du contrat). `turn_id` est optionnel.
pub(crate) fn emit_companion_state(app: &AppHandle, state: &str, turn_id: Option<&str>) {
    let payload = match turn_id {
        Some(id) => serde_json::json!({ "state": state, "turnId": id }),
        None => serde_json::json!({ "state": state }),
    };
    let _ = app.emit(COMPANION_STATE_EVENT, payload);
}

/// Déplacement utilisateur : mémorise la nouvelle ancre.
fn on_window_moved(window: &Window, position: PhysicalPosition<i32>) {
    // Un déplacement programmé pendant un changement de bulle ne doit pas écraser l'ancre.
    if LAYOUT_LOCK.try_lock().is_err() {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical = position.to_logical::<f64>(scale);
    let offset = claaky_offset(
        BUBBLE_OPEN.load(Ordering::SeqCst),
        BUBBLE_TO_LEFT.load(Ordering::SeqCst),
    );
    schedule_position_save(
        window.app_handle(),
        (logical.x + offset.0, logical.y + offset.1),
    );
}

/// Événements de la fenêtre compagnon. Fermer la fenêtre la cache seulement : elle reste vivante
/// pour Ask et le raccourci. Appelé depuis `on_window_event` de lib.rs pour ce label uniquement.
pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::Moved(position) => on_window_moved(window, *position),
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
        }
        _ => {}
    }
}

#[tauri::command]
pub(super) fn companion_get_position(
    state: State<'_, DesktopState>,
) -> Option<CompanionPosition> {
    state
        .store
        .load_json_setting::<CompanionPosition>(COMPANION_POSITION_KEY)
        .ok()
        .flatten()
}

#[tauri::command]
pub(super) fn companion_set_bubble_open(
    app: AppHandle,
    open: bool,
) -> std::result::Result<(), String> {
    set_bubble_open(&app, open).map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn companion_toggle_bubble(app: AppHandle) -> std::result::Result<(), String> {
    toggle_bubble(&app).map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn companion_hide(app: AppHandle) -> std::result::Result<(), String> {
    hide_companion_window(&app).map_err(|err| err.to_string())
}
