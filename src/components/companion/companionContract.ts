/**
 * Contrat partagé du compagnon Claaky2D sur le bureau.
 * Source de vérité des noms de commandes Tauri, d'événements, de clés de réglages et des types
 * échangés entre le front et le Rust (src-tauri/src/companion*.rs). Toute modification ici doit
 * être répercutée côté Rust (serde rename_all = "camelCase").
 */
import type { ClaakyState } from "../claaky/Claaky";

/** Label de la fenêtre de bureau (transparente, toujours au premier plan). */
export const COMPANION_WINDOW_LABEL = "claaky-companion";
/** URL chargée par la fenêtre compagnon : index.html?companion=1. */
export const COMPANION_WINDOW_URL = "index.html?companion=1";
/** Label de la fenêtre principale visée par le mode code (Claake Code). */
export const MAIN_WINDOW_LABEL = "main";

/** Clés app_settings (table SQLite existante, valeur JSON). */
export const COMPANION_SETTINGS_KEY = "companion_settings";
export const COMPANION_POSITION_KEY = "companion_position";

/** Raccourci global par défaut : Contrôle + Option + Espace (format Tauri). */
export const COMPANION_DEFAULT_SHORTCUT = "Control+Alt+Space";

/** Noms d'événements (kebab-case, comme agent-event). */
export const COMPANION_EVENTS = {
  /** Rust -> fenêtre compagnon : pose de Claaky. */
  state: "companion-state",
  /** Rust -> fenêtre compagnon : progression d'un tour Ask (delta, fin, erreur). */
  turn: "companion-turn",
  /** Rust -> fenêtre compagnon : début de transition (le contenu doit fondre avant le changement de géométrie). */
  fading: "companion-bubble-fading",
  /** Rust -> fenêtre compagnon : bulle ouverte ou fermée (géométrie déjà appliquée). */
  bubbleChanged: "companion-bubble-changed",
  /** Rust -> toutes fenêtres : réglages modifiés. */
  settingsChanged: "companion-settings-changed",
  /** Rust -> fenêtre principale : tâche code transmise en direct. */
  forwardTask: "companion-forward-task",
  /** Rust -> fenêtre principale : reprendre une conversation compagnon. */
  continueRequested: "companion-continue-requested",
} as const;

/** Modes du compagnon. Ask = autonome, code = délégué à Claake Code. */
export type CompanionMode = "ask" | "code";

export type CompanionSettings = {
  /** Raccourci global, format Tauri (ex. « Alt+Space »). */
  shortcut: string;
  defaultMode: CompanionMode;
  /** Modèles autorisés, valeurs « provider:id » issues de src/lib/models.ts. Vide = tous. */
  allowedModels: string[];
  /** Modèle sélectionné par défaut, parmi allowedModels. */
  defaultModel: string | null;
  /** Lancement de l'app à l'ouverture de session macOS. */
  launchAtLogin: boolean;
};

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  shortcut: COMPANION_DEFAULT_SHORTCUT,
  defaultMode: "ask",
  allowedModels: [],
  defaultModel: null,
  launchAtLogin: false,
};

export type CompanionPosition = { x: number; y: number };

/** Pièce jointe : zone d'écran capturée (PNG base64) ou texte collé/joint. */
export type CompanionAttachment =
  | { kind: "image"; name: string; mime: "image/png"; dataBase64: string }
  | { kind: "text"; name: string; text: string };

export type CompanionAskInput = {
  /** Absent = nouvelle conversation compagnon. */
  conversationId?: string;
  text: string;
  mode: CompanionMode;
  /** « provider:id » ; absent = defaultModel des réglages. */
  model?: string;
  attachments: CompanionAttachment[];
};

export type CompanionAskStarted = { turnId: string; conversationId: string };

/** Événement companion-turn. */
export type CompanionTurnEvent =
  | { turnId: string; conversationId: string; kind: "delta"; text: string }
  | { turnId: string; conversationId: string; kind: "finished" }
  | { turnId: string; conversationId: string; kind: "error"; error: string };

/** Événement companion-state : pose de Claaky pour le tour en cours. */
export type CompanionStateEvent = { state: ClaakyState; turnId?: string };

export type CompanionMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Noms des pièces jointes (contenu non persisté dans l'historique). */
  attachmentNames: string[];
  createdAtMs: number;
  error?: string;
};

export type CompanionConversationSummary = {
  id: string;
  title: string;
  updatedAtMs: number;
};

export type CompanionConversation = CompanionConversationSummary & {
  model: string;
  messages: CompanionMessage[];
};

/** Tâche code en attente de prise en charge par la fenêtre principale. */
export type CompanionPendingForward = {
  text: string;
  attachments: CompanionAttachment[];
  model?: string;
  /** Conversation compagnon d'origine, si la demande vient d'une reprise. */
  sourceConversationId?: string;
};

export type CompanionBubbleEvent = { open: boolean; side?: "left" | "right" };

/**
 * Commandes Tauri (snake_case côté Rust, invoke() côté front).
 * Propriétaire indiqué entre crochets dans la tâche #1.
 *
 * Fenêtre / position / bulle [bureau] :
 *   companion_get_settings() -> CompanionSettings            [intégration]
 *   companion_save_settings(settings) -> CompanionSettings   [intégration]
 *   companion_get_position() -> CompanionPosition | null     [bureau]
 *   companion_set_bubble_open(open: bool) -> void            [bureau]
 *     (redimensionne la fenêtre, ancre Claaky, émet companion-bubble-changed)
 *   companion_toggle_bubble() -> void                        [bureau]
 *     (même effet que le clic sur Claaky, le raccourci et la barre des menus)
 *   companion_set_bubble_height(height: number) -> void      [bureau]
 *     (bulle ouverte uniquement : borne 200-560, ancre Claaky conservée)
 *
 * Conversation Ask / historique / capture [bulle] :
 *   companion_ask(input: CompanionAskInput) -> CompanionAskStarted
 *     (mode ask : traité ici ; mode code : délègue à companion_forward_to_claake_code)
 *   companion_cancel(turnId: string) -> void
 *   companion_history_list() -> CompanionConversationSummary[]
 *   companion_history_load(id: string) -> CompanionConversation
 *   companion_history_delete(id: string) -> void
 *   companion_capture_region() -> CompanionAttachment | null  (null = annulé)
 *
 * Liens Claake Code / entrées / tray [intégration] :
 *   companion_forward_to_claake_code(input: CompanionAskInput) -> void
 *     (ouvre Claake Code si fermé, puis transmet via companion-forward-task ou pending)
 *   companion_take_pending_forward() -> CompanionPendingForward | null
 *     (appelée au démarrage de la fenêtre principale)
 *   companion_open_claake_code() -> void
 *   companion_continue_in_app(conversationId: string) -> void
 *   companion_report_state(state: ClaakyState) -> void
 *     (appelée par la fenêtre principale ; Rust relaie en companion-state)
 */
export const COMPANION_COMMANDS = {
  getSettings: "companion_get_settings",
  saveSettings: "companion_save_settings",
  getPosition: "companion_get_position",
  setBubbleOpen: "companion_set_bubble_open",
  toggleBubble: "companion_toggle_bubble",
  /** Redimensionne la hauteur de la bulle selon le contenu mesuré (min 200, max 560). */
  setBubbleHeight: "companion_set_bubble_height",
  hide: "companion_hide",
  ask: "companion_ask",
  cancel: "companion_cancel",
  historyList: "companion_history_list",
  historyLoad: "companion_history_load",
  historyDelete: "companion_history_delete",
  captureRegion: "companion_capture_region",
  forwardToClaakeCode: "companion_forward_to_claake_code",
  takePendingForward: "companion_take_pending_forward",
  openClaakeCode: "companion_open_claake_code",
  continueInApp: "companion_continue_in_app",
  reportState: "companion_report_state",
} as const;
