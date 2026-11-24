import { useRef, useState } from "react";
import { Icon } from "@iconify/react";
import type { ConversationSummary } from "../types";
import { BlobAvatar, shortRelativeTime } from "./BlobAvatar";

type Props = {
  conversations: ConversationSummary[];
  activeId: string | null;
  streamingIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** Empty-list text (the RLM tab has its own history). */
  emptyLabel?: string;
};

/// "Auto Compute · J'ai relu…" → { kicker: "Auto Compute", name: "J'ai relu…" }.
/// Titles without a " · " prefix keep their full text as name.
function splitTitle(title: string): { kicker: string | null; name: string } {
  const idx = title.indexOf(" · ");
  if (idx > 0 && idx < 32) {
    return { kicker: title.slice(0, idx), name: title.slice(idx + 3) || title };
  }
  return { kicker: null, name: title };
}

// Renders only the body of the conversations list. The parent owns the
// `sidebar__section` shell and the head (now shared with the Git tab),
// so this component focuses on the actual list of rows.
export function ConversationList({
  conversations,
  activeId,
  streamingIds,
  onSelect,
  onRename,
  onDelete,
  emptyLabel,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editRef = useRef<HTMLSpanElement | null>(null);

  const commitRename = (id: string) => {
    const value = editRef.current?.textContent?.trim() ?? "";
    setEditingId(null);
    if (value) {
      onRename(id, value);
    }
  };

  return (
    <div className="sidebar__body">
      <div className="conv-list">
        {conversations.length === 0 && (
          <div className="conv-empty">{emptyLabel ?? "No conversations yet."}</div>
        )}
        {conversations.map((conv) => {
          const isEditing = editingId === conv.id;
          const isActive = activeId === conv.id;
          const isStreaming = streamingIds.has(conv.id);
          const fullTitle = conv.title || "Untitled";
          const parts = splitTitle(fullTitle);
          return (
            <div
              key={conv.id}
              className="conv-row"
              data-active={isActive ? "true" : "false"}
              data-streaming={isStreaming ? "true" : "false"}
              onClick={() => !isEditing && onSelect(conv.id)}
            >
              <span className="conv-row__avatar">
                <BlobAvatar seed={conv.id} size={26} />
                {isStreaming && (
                  <span className="conv-row__spinner" aria-label="Streaming" />
                )}
              </span>
              <span className="conv-row__text">
                <span className="conv-row__line">
                  <span
                    ref={isEditing ? editRef : undefined}
                    className="conv-row__title"
                    contentEditable={isEditing}
                    suppressContentEditableWarning
                    onKeyDown={(event) => {
                      if (!isEditing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename(conv.id);
                      } else if (event.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                    onBlur={() => {
                      if (isEditing) commitRename(conv.id);
                    }}
                  >
                    {isEditing ? fullTitle : parts.name}
                  </span>
                  <span className="conv-row__time">
                    {isStreaming ? "en cours" : shortRelativeTime(conv.updatedAtMs)}
                  </span>
                </span>
                {!isEditing && (
                  <span className="conv-row__sub">
                    {parts.kicker ?? (conv.harness === "rlm" ? "Chat RLM" : "Conversation")}
                  </span>
                )}
              </span>
              <span className="conv-row__actions">
                <button
                  className="conv-row__btn"
                  title="Rename"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditingId(conv.id);
                    queueMicrotask(() => {
                      const node = editRef.current;
                      if (node) {
                        node.focus();
                        const sel = window.getSelection();
                        const range = document.createRange();
                        range.selectNodeContents(node);
                        sel?.removeAllRanges();
                        sel?.addRange(range);
                      }
                    });
                  }}
                >
                  <Icon icon="solar:pen-linear" width={13} height={13} />
                </button>
                <button
                  className="conv-row__btn conv-row__btn--danger"
                  title="Delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (confirm("Delete this conversation?")) {
                      onDelete(conv.id);
                    }
                  }}
                >
                  <Icon icon="solar:trash-bin-minimalistic-linear" width={13} height={13} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
