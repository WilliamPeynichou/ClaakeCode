import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../../lib/ipc";
import {
  availableModelsForProviders,
  useModelCatalogVersion,
  type ModelEntry,
} from "../../lib/models";
import type { OpenRouterModel, MistralModel } from "../../types";
import {
  COMPANION_COMMANDS,
  COMPANION_EVENTS,
  DEFAULT_COMPANION_SETTINGS,
  type CompanionAskInput,
  type CompanionAttachment,
  type CompanionConversation,
  type CompanionConversationSummary,
  type CompanionMessage,
  type CompanionMode,
  type CompanionSettings,
  type CompanionTurnEvent,
} from "./companionContract";
import {
  companionChatApi,
  imageFileToPngBase64,
  textAttachmentFromFile,
} from "./companionChatApi";
import "./companionBubble.css";

type Props = {
  /** Ferme la bulle (le clic sur Claaky ou le raccourci la rouvrent). */
  onClose?: () => void;
};

type PendingMessage = CompanionMessage & { pending?: boolean };

const TEXT_FILE_ACCEPT = ".txt,.md,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.rs,.go,.html,.css,.yml,.yaml,.toml,.sql,text/*";
/** Hauteur maximale de la zone de saisie avant défilement interne (~6 lignes à 12 px). */
const COMPOSER_MAX_HEIGHT_PX = 96;

/**
 * Bulle de chat du compagnon : mode Ask (réponse directe, sans Claake Code) ou Code (transmis à
 * Claake Code, ouvert au besoin par le backend). Autonome : ne dépend pas de la fenêtre principale.
 */
export function CompanionBubble({ onClose }: Props) {
  const [mode, setMode] = useState<CompanionMode>(DEFAULT_COMPANION_SETTINGS.defaultMode);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [model, setModel] = useState<string>("");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<CompanionAttachment[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [conversationTitle, setConversationTitle] = useState("");
  const [messages, setMessages] = useState<PendingMessage[]>([]);
  const [turnId, setTurnId] = useState<string | null>(null);
  const [history, setHistory] = useState<CompanionConversationSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turnRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /** Saisie auto-agrandissante (plafonnée : au-delà, le textarea défile). */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [text]);

  const busy = turnId !== null;

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await companionChatApi.historyList());
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // Réglages + modèles autorisés, chargés à l'ouverture de la bulle (et si le catalogue change).
  const catalogVersion = useModelCatalogVersion();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [loaded, providers, openRouter, mistral] = await Promise.all([
        invoke<CompanionSettings>(COMPANION_COMMANDS.getSettings).catch(() => DEFAULT_COMPANION_SETTINGS),
        api.listConfiguredModelProviders().catch(() => [] as string[]),
        api.listOpenRouterModels().catch(() => [] as OpenRouterModel[]),
        api.listMistralModels().catch(() => [] as MistralModel[]),
      ]);
      if (cancelled) return;
      const available = availableModelsForProviders(providers, openRouter, mistral);
      const allowed = loaded.allowedModels;
      const usable = allowed.length > 0 ? available.filter((m) => allowed.includes(m.value)) : available;
      setMode(loaded.defaultMode);
      setModels(usable);
      setModel(
        usable.find((m) => m.value === loaded.defaultModel)?.value ?? usable[0]?.value ?? "",
      );
    })();
    void refreshHistory();
    return () => {
      cancelled = true;
    };
  }, [refreshHistory, catalogVersion]);

  // Progression du tour Ask : deltas, fin et erreur. Filtrés sur le tour courant.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<CompanionTurnEvent>(COMPANION_EVENTS.turn, (event) => {
      const payload = event.payload;
      if (payload.turnId !== turnRef.current) return;
      if (payload.kind === "delta") {
        setMessages((current) => {
          const next = current.slice();
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = { ...last, text: last.text + payload.text };
          }
          return next;
        });
      } else if (payload.kind === "finished") {
        turnRef.current = null;
        setTurnId(null);
        void (async () => {
          try {
            const conversation = await companionChatApi.historyLoad(payload.conversationId);
            setMessages(conversation.messages);
            setConversationTitle(conversation.title);
          } catch {
            // Historique indisponible : on garde la conversation affichée.
          }
          void refreshHistory();
        })();
      } else {
        turnRef.current = null;
        setTurnId(null);
        setError(payload.error);
        setMessages((current) => current.map((m) => (m.pending ? { ...m, pending: false } : m)));
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshHistory]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const reset = () => {
    setConversationId(undefined);
    setConversationTitle("");
    setMessages([]);
    setText("");
    setAttachments([]);
    setError(null);
    setNotice(null);
  };

  const openConversation = async (id: string) => {
    try {
      const conversation: CompanionConversation = await companionChatApi.historyLoad(id);
      setConversationId(conversation.id);
      setConversationTitle(conversation.title);
      setMessages(conversation.messages);
      if (models.some((m) => m.value === conversation.model)) setModel(conversation.model);
      setShowHistory(false);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const removeConversation = async (id: string) => {
    try {
      await companionChatApi.historyDelete(id);
      if (id === conversationId) reset();
      await refreshHistory();
    } catch (err) {
      setError(String(err));
    }
  };

  const send = async () => {
    const value = text.trim();
    if (busy || (!value && attachments.length === 0)) return;
    setError(null);
    setNotice(null);
    const input: CompanionAskInput = {
      conversationId,
      text: value,
      mode,
      model: model || undefined,
      attachments,
    };

    if (mode === "code") {
      try {
        await invoke<void>(COMPANION_COMMANDS.forwardToClaakeCode, { input });
        setNotice("Transmis à Claake Code.");
        setText("");
        setAttachments([]);
      } catch (err) {
        setError(String(err));
      }
      return;
    }

    try {
      const started = await companionChatApi.ask(input);
      turnRef.current = started.turnId;
      setTurnId(started.turnId);
      setConversationId(started.conversationId);
      setMessages((current) => [
        ...current,
        {
          id: `user-${started.turnId}`,
          role: "user",
          text: value,
          attachmentNames: attachments.map((a) => a.name),
          createdAtMs: Date.now(),
        },
        {
          id: `assistant-${started.turnId}`,
          role: "assistant",
          text: "",
          attachmentNames: [],
          createdAtMs: Date.now(),
          pending: true,
        },
      ]);
      setText("");
      setAttachments([]);
    } catch (err) {
      setError(String(err));
    }
  };

  const cancel = async () => {
    if (!turnId) return;
    try {
      await companionChatApi.cancel(turnId);
    } catch (err) {
      setError(String(err));
    }
  };

  const capture = async () => {
    setError(null);
    try {
      const attachment = await companionChatApi.captureRegion();
      if (attachment) setAttachments((current) => [...current, attachment]);
    } catch (err) {
      setError(String(err));
    }
  };

  const onPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    try {
      const added: CompanionAttachment[] = [];
      for (const file of images) {
        added.push({
          kind: "image",
          name: file.name || "image-collée.png",
          mime: "image/png",
          dataBase64: await imageFileToPngBase64(file),
        });
      }
      setAttachments((current) => [...current, ...added]);
    } catch (err) {
      setError(String(err));
    }
  };

  const attachTextFiles = async (files: FileList | null) => {
    if (!files) return;
    try {
      const added = await Promise.all(Array.from(files).map(textAttachmentFromFile));
      setAttachments((current) => [...current, ...added]);
    } catch (err) {
      setError(String(err));
    }
  };

  const continueInApp = async () => {
    if (!conversationId) return;
    try {
      await invoke<void>(COMPANION_COMMANDS.continueInApp, { conversationId });
    } catch (err) {
      setError(String(err));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape") {
      onClose?.();
    }
  };

  const modelLabel = useMemo(
    () => models.find((m) => m.value === model)?.label ?? model,
    [models, model],
  );

  return (
    <section className="companion-bubble" aria-label="Chat Claaky">
      <header className="companion-bubble__head" data-tauri-drag-region title="Glisser pour déplacer">
        <div className="companion-bubble__title" data-tauri-drag-region>
          <strong data-tauri-drag-region>{conversationTitle || "Claaky"}</strong>
          {conversationId && <span className="companion-bubble__muted">{modelLabel}</span>}
        </div>
        <div className="companion-bubble__actions">
          <button type="button" onClick={reset} aria-label="Nouvelle conversation" title="Nouvelle conversation">
            +
          </button>
          <button
            type="button"
            onClick={() => setShowHistory((value) => !value)}
            aria-pressed={showHistory}
            title="Historique du compagnon"
          >
            Historique
          </button>
          {conversationId && (
            <button type="button" onClick={() => void continueInApp()} title="Reprendre dans Claake Code">
              Continuer dans Claake Code
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Fermer la bulle" title="Fermer (Échap)">
              ×
            </button>
          )}
        </div>
      </header>

      {showHistory && (
        <ul className="companion-bubble__history">
          {history.length === 0 && <li className="companion-bubble__muted">Aucune conversation.</li>}
          {history.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => void openConversation(item.id)}>
                {item.title}
              </button>
              <button
                type="button"
                aria-label={`Supprimer « ${item.title} »`}
                onClick={() => void removeConversation(item.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="companion-bubble__messages" ref={listRef} aria-live="polite">
        {messages.length === 0 && (
          <p className="companion-bubble__muted">
            Posez une question. Mode Code : la tâche part dans Claake Code.
          </p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`companion-bubble__message companion-bubble__message--${message.role}`}
          >
            {message.attachmentNames.length > 0 && (
              <span className="companion-bubble__muted">Pièces jointes : {message.attachmentNames.join(", ")}</span>
            )}
            <p>{message.text || (message.pending ? "…" : "")}</p>
          </div>
        ))}
      </div>

      {error && <p className="companion-bubble__error" role="alert">{error}</p>}
      {notice && <p className="companion-bubble__notice" role="status">{notice}</p>}

      {attachments.length > 0 && (
        <ul className="companion-bubble__attachments">
          {attachments.map((attachment, index) => (
            <li key={`${attachment.name}-${index}`}>
              <span>{attachment.name}</span>
              <button
                type="button"
                aria-label={`Retirer ${attachment.name}`}
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="companion-bubble__composer">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => void onPaste(event)}
          placeholder={mode === "ask" ? "Demandez à Claaky…" : "Décrivez la tâche pour Claake Code…"}
          rows={1}
          aria-label="Message"
        />
        <div className="companion-bubble__controls">
          <div className="companion-bubble__mode" role="group" aria-label="Mode">
            <button
              type="button"
              aria-pressed={mode === "ask"}
              onClick={() => setMode("ask")}
            >
              Ask
            </button>
            <button
              type="button"
              aria-pressed={mode === "code"}
              onClick={() => setMode("code")}
            >
              Code
            </button>
          </div>
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            aria-label="Modèle"
            disabled={models.length === 0}
          >
            {models.length === 0 && <option value="">Aucun modèle autorisé</option>}
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void capture()} title="Capturer une zone de l'écran">
            Zone
          </button>
          <label className="companion-bubble__file" title="Joindre un fichier texte">
            Fichier
            <input
              type="file"
              accept={TEXT_FILE_ACCEPT}
              multiple
              onChange={(event) => {
                void attachTextFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          {busy ? (
            <button type="button" onClick={() => void cancel()}>
              Arrêter
            </button>
          ) : (
            <button
              type="button"
              className="companion-bubble__send"
              onClick={() => void send()}
              disabled={!text.trim() && attachments.length === 0}
            >
              Envoyer
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
