// Wire types of the phone protocol (src-tauri/src/remote.rs). Desktop types are shared from src/types.ts.
import type {
  ActiveTurnReplay,
  ActiveTurnSummary,
  AgentEvent,
  AgentMode,
  ConversationSummary,
  ModeModelSettings,
  ModelRef,
  OpenRouterModel,
  PlanControl,
  SavedConversation,
  ThinkingLevel,
  WorkspaceBootstrap,
  WorkspaceInfo,
} from "../../../../src/types";

export type {
  ActiveTurnReplay,
  ActiveTurnSummary,
  AgentEvent,
  AgentMode,
  ConversationSummary,
  ModeModelSettings,
  ModelRef,
  SavedConversation,
  ThinkingLevel,
  WorkspaceBootstrap,
  WorkspaceInfo,
};

/** The phone protocol has no "minimal" level (ThinkingLevelInput). */
export type PhoneThinking = Exclude<ThinkingLevel, "minimal">;

export type Attachment = { name: string; mediaType: string; data?: string; path?: string };

export type PhoneCommand =
  | { type: "bootstrap" }
  | { type: "list_conversations" }
  | { type: "create_conversation"; harness?: "classic" | "rlm" }
  | { type: "load_conversation"; conversation_id: string }
  | { type: "delete_conversation"; conversation_id: string }
  | { type: "set_conversation_mode"; conversation_id: string; mode: AgentMode }
  | { type: "list_models" }
  | {
      type: "set_conversation_model";
      conversation_id: string;
      mode: AgentMode;
      model: { provider: string; name: string };
      thinking: PhoneThinking;
    }
  | {
      type: "send_message";
      conversation_id: string;
      text: string;
      attachments: Attachment[];
      mode: AgentMode;
      model?: { provider: string; name: string };
      thinking?: PhoneThinking;
      plan_control?: PlanControl;
      message_visibility?: "normal" | "systemReminder";
      voice: boolean;
    }
  | { type: "cancel_turn"; conversation_id: string }
  | { type: "compact_conversation"; conversation_id: string; model?: ModelRef; thinking?: PhoneThinking }
  | { type: "answer_question"; conversation_id: string; tool_call_id: string; answers: string[][]; stop_questions: boolean }
  | { type: "reject_question"; conversation_id: string; tool_call_id: string }
  | { type: "replay_active_turn_events"; conversation_id: string; after_sequence: number }
  | { type: "subscribe_push"; subscription: PushSubscriptionJSON }
  | { type: "unsubscribe_push"; endpoint: string }
  | { type: "presence"; visible: boolean }
  | { type: "ping" };

export type BootstrapResponse = {
  workspacePath: string;
  workspaces: WorkspaceInfo[];
  bootstrap: WorkspaceBootstrap;
  activeTurns: ActiveTurnSummary[];
  rlmAvailable?: boolean;
};

export type CatalogModel = {
  provider: string;
  id: string;
  label: string;
  thinking: string[];
  defaultThinking: string;
  hidden?: boolean;
};

export type ModelsResponse = {
  providers: string[];
  openrouterModels: OpenRouterModel[];
  modelCatalog: CatalogModel[];
};

export type PcPayload =
  | { type: "agent_event"; workspace_id: string; conversation_id: string; sequence?: number | null; event: AgentEvent }
  | { type: "active_turns_changed"; active_turns: ActiveTurnSummary[] }
  | { type: "device_revoked" };
