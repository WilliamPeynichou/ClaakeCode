import { Icon } from "@iconify/react";
import type { ChatMessage } from "../../types";

export type ChatSurface = "chat" | "rlm";

/** Conversations without a harness come from older backends: they are classic chats. */
export function surfaceOf(conversation?: { harness?: "classic" | "rlm" }): ChatSurface {
  return conversation?.harness === "rlm" ? "rlm" : "chat";
}

/** "Chat | RLM" switch shown in the chat header. Each surface has its own history. */
export function ChatSurfaceTabs({
  surface,
  onChange,
  streaming,
}: {
  surface: ChatSurface;
  onChange: (surface: ChatSurface) => void;
  /** Surfaces with a running turn somewhere (dot on the inactive tab). */
  streaming: Record<ChatSurface, boolean>;
}) {
  const tab = (id: ChatSurface, label: string, icon: string, hint: string) => (
    <button
      type="button"
      role="tab"
      className="chat-surface-tab"
      data-surface={id}
      data-active={surface === id ? "true" : "false"}
      aria-selected={surface === id}
      title={hint}
      onClick={() => onChange(id)}
    >
      <Icon icon={icon} width={14} height={14} />
      <span>{label}</span>
      {streaming[id] && surface !== id && (
        <span className="chat-surface-tab__live" aria-label="turn running" />
      )}
    </button>
  );
  return (
    <div className="chat-surface-tabs" role="tablist" aria-label="Chat type">
      {tab("chat", "Chat", "solar:chat-square-code-bold-duotone", "Agent chat")}
      {tab("rlm", "RLM", "solar:cpu-bolt-bold-duotone", "RLM chat (experimental, Prime Agent): persistent Python, isolated worktree")}
    </div>
  );
}

/** Shown on the RLM tab while the workspace has no RLM conversation yet. */
export function RlmEmptyState({
  available,
  creating,
  error,
  onCreate,
}: {
  available: boolean;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  return (
    <div className="rlm-empty">
      <span className="chat-empty__mark">
        <Icon icon="solar:cpu-bolt-bold-duotone" width={22} height={22} />
      </span>
      <span className="chat-empty__title">RLM chat</span>
      <p className="rlm-empty__text">
        Un agent Prime avec un Python persistant : les variables survivent d'un message à
        l'autre. Chaque conversation travaille dans son propre worktree git et a son propre
        historique, séparé du chat agent.
      </p>
      {available ? (
        <button
          type="button"
          className="rlm-empty__cta"
          onClick={onCreate}
          disabled={creating}
        >
          <Icon icon="solar:add-square-linear" width={14} height={14} />
          <span>{creating ? "Création du worktree…" : "Nouveau chat RLM"}</span>
        </button>
      ) : (
        <p className="rlm-empty__muted">Le chat RLM n'est pas encore disponible sur Windows.</p>
      )}
      <p className="rlm-empty__muted">
        Astuce : depuis le chat agent, le bouton <b>Auto Compute</b> ouvre un chat RLM qui
        reprend la conversation.
      </p>
      {error && <p className="rlm-empty__error">{error}</p>}
    </div>
  );
}

/** Max transcript characters handed to the RLM agent (most recent kept). */
const AUTO_COMPUTE_MAX_CHARS = 24_000;

/** Readable text transcript of a classic chat: text parts, plus tool names as markers. */
export function autoComputeTranscript(history: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const chunks: string[] = [];
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) chunks.push(part.text.trim());
      else if (part.type === "tool_call") chunks.push(`[tool: ${part.name}]`);
    }
    if (chunks.length) lines.push(`${message.role.toUpperCase()}: ${chunks.join("\n")}`);
  }
  const full = lines.join("\n\n");
  return full.length > AUTO_COMPUTE_MAX_CHARS
    ? `[… earlier messages truncated …]\n${full.slice(full.length - AUTO_COMPUTE_MAX_CHARS)}`
    : full;
}

export function autoComputePrompt(sourceTitle: string, transcript: string): string {
  return [
    `Auto Compute from the agent chat "${sourceTitle || "Untitled"}".`,
    "",
    "Below is that conversation (text only, most recent last). Use your persistent Python to " +
      "compute, verify or analyse what it needs: re-run calculations, inspect data, test the claims " +
      "and hypotheses. Do not assume earlier tool results are still valid. Finish with a short " +
      "summary of the results and of anything the agent chat should change.",
    "",
    "<agent_chat>",
    transcript,
    "</agent_chat>",
  ].join("\n");
}

/** Prompt sent by the "Apprendre de ce chat" button: asks Prime to consolidate through its own memory API. */
export const LEARN_PROMPT =
  "Learn from this conversation now. Using your persisted harness memory (rlm.harness), review what happened " +
  "so far and save only durable, verified items: user corrections and preferences, facts about this project, " +
  "and tactics that worked or failed, each with its evidence. Check existing entries first; update or delete " +
  "stale or duplicate ones instead of adding new ones. Never store secrets, tokens or raw private text. " +
  "Use global scope only for lessons useful in other chats. Then list what you actually saved, updated or " +
  "removed, or say plainly that nothing was worth keeping.";
