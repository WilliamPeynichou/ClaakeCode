import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { extractSpoken } from "../../../../src/lib/spoken";
import { blocksFromEvents, blocksFromHistory, type Block } from "../chat/blocks";
import { AgentRow, AgentText, Notice, QuestionCard, Thinking, ToolRow, UserBubble } from "../chat/parts";
import type { AgentMode, Attachment, PhoneThinking } from "../protocol/types";
import { toBase64 } from "../protocol/crypto";
import { speak } from "../speech";
import { VoicePanel } from "./Voice";
import { findEntry, modelEntries, thinkingOf, type ModelEntry, type Remote } from "../state";
import { BackButton, ConnectionBanner, NavBar, NavButton, Spinner, conversationTitle, duration } from "../ui/common";
import { Icon, type IconName } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";

const MODES: { value: AgentMode; label: string; icon: IconName; hint: string }[] = [
  { value: "act", label: "Agir", icon: "bolt", hint: "L'agent modifie le code et lance des commandes." },
  { value: "ask", label: "Demander", icon: "ask", hint: "Questions et explications, sans rien modifier." },
  { value: "plan", label: "Planifier", icon: "list", hint: "L'agent prépare un plan que tu valides avant qu'il agisse." },
  { value: "goal", label: "Objectif", icon: "flag", hint: "L'agent continue seul jusqu'à atteindre l'objectif." },
];

const THINKING_LABELS: Record<PhoneThinking, string> = {
  off: "Aucune",
  low: "Faible",
  medium: "Moyenne",
  high: "Élevée",
  xhigh: "Très élevée",
  max: "Max",
};

const PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  kimi: "Kimi",
  mistral: "Mistral",
  xai: "xAI",
  openrouter: "OpenRouter",
};

// Photos are resized on the phone: smaller uploads, and relay frames stay well under the size limit.
const PHOTO_MAX_SIDE = 1600;

async function photoAttachment(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Photo illisible."))), "image/jpeg", 0.82),
  );
  const name = `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`;
  return { name, mediaType: "image/jpeg", data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
}

/** Consecutive tool steps render as one card, like a compact activity log. */
function groupBlocks(blocks: Block[]): (Block | Block[])[] {
  const out: (Block | Block[])[] = [];
  for (const block of blocks) {
    const step = (block.kind === "tool" && block.name !== "question") || block.kind === "agent";
    const last = out[out.length - 1];
    if (step && Array.isArray(last)) last.push(block);
    else out.push(step ? [block] : block);
  }
  return out;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function ModelSheet({ remote, open, onClose }: { remote: Remote; open: boolean; onClose(): void }) {
  const entries = useMemo(() => modelEntries(remote.models), [remote.models]);
  const conversation = remote.open;
  const model = conversation ? (conversation.modeModelSettings?.[remote.mode] ?? conversation.model) : null;
  const current = findEntry(entries, model);
  const thinking = thinkingOf(model);
  const groups = useMemo(() => {
    const map = new Map<string, ModelEntry[]>();
    for (const entry of entries) map.set(entry.provider, [...(map.get(entry.provider) ?? []), entry]);
    return [...map.entries()];
  }, [entries]);

  const choose = (entry: ModelEntry, level?: PhoneThinking) => {
    const next = level ?? (entry.thinking.includes(thinking) ? thinking : entry.defaultThinking);
    void remote.actions.setModel(entry, next);
  };

  return (
    <Sheet open={open} title="Modèle" onClose={onClose}>
      {current && current.thinking.length > 1 && (
        <section className="group">
          <div className="group__body">
            {/* A native picker: up to six levels do not fit in a segmented control on a phone. */}
            <div className="row row--compact row--select">
              <span className="row__text" aria-hidden="true">
                <strong>Réflexion</strong>
              </span>
              <span className="row__value" aria-hidden="true">{THINKING_LABELS[thinking]}</span>
              <span className="row__chevron" aria-hidden="true">
                <Icon name="updown" size={16} />
              </span>
              <select aria-label="Réflexion" value={thinking} onChange={(event) => choose(current, event.target.value as PhoneThinking)}>
                {current.thinking.map((level) => (
                  <option key={level} value={level}>
                    {THINKING_LABELS[level]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      )}
      {entries.length === 0 && (
        <div className="empty">
          <Spinner />
        </div>
      )}
      {groups.map(([provider, items]) => (
        <section key={provider} className="group">
          <h2 className="group__title">{PROVIDERS[provider] ?? provider}</h2>
          <div className="group__body">
            {items.map((entry) => (
              <button key={`${entry.provider}:${entry.name}`} type="button" className="row row--compact" onClick={() => choose(entry)}>
                <span className="row__text">
                  <strong>{entry.label}</strong>
                </span>
                {current === entry && <span className="row__check"><Icon name="check" size={18} stroke={2.4} /></span>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </Sheet>
  );
}

function Composer({ remote, voice, onVoice, onOpenModel, onOpenMode }: {
  remote: Remote;
  voice: boolean;
  onVoice(on: boolean): void;
  onOpenModel(): void;
  onOpenMode(): void;
}) {
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const conversation = remote.open;
  const rlm = Boolean(conversation && remote.conversations.find((c) => c.id === conversation.id)?.harness === "rlm");
  const mode = MODES.find((m) => m.value === remote.mode) ?? MODES[0];
  const model = conversation ? (conversation.modeModelSettings?.[remote.mode] ?? conversation.model) : null;
  const entry = findEntry(modelEntries(remote.models), model);
  const ready = Boolean(conversation) && remote.connection.mac;
  const canSend = ready && text.trim().length > 0 && !sending;
  const showStop = remote.busy && !text.trim() && photos.length === 0;

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  async function submit() {
    if (!canSend) return;
    setSending(true);
    const sent = await remote.actions.send({ text: text.trim(), attachments: photos });
    setSending(false);
    if (sent) {
      setText("");
      setPhotos([]);
    }
  }

  async function addPhotos(files: FileList | null) {
    if (!files) return;
    try {
      const added = await Promise.all([...files].slice(0, 4).map(photoAttachment));
      setPhotos((current) => [...current, ...added].slice(0, 4));
    } catch (err) {
      remote.actions.fail(err);
    }
  }

  const queued = remote.queued && (
    <div className="composer__queued">
      <Icon name="flag" size={14} />
      <span>Envoyé dès que l'agent a fini : « {remote.queued.text} »</span>
      <button type="button" aria-label="Annuler l'envoi" onClick={remote.actions.unqueue}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );

  if (voice) {
    return (
      <div className="composer composer--voice">
        {queued}
        <VoicePanel
          initialText={text}
          ready={ready}
          onKeyboard={(spoken) => {
            setText(spoken);
            onVoice(false);
          }}
          onSend={async (spoken) => {
            const sent = await remote.actions.send({ text: spoken, attachments: photos });
            if (sent) {
              setText("");
              setPhotos([]);
            }
            return sent;
          }}
        />
      </div>
    );
  }

  return (
    <div className="composer">
      {queued}
      {photos.length > 0 && (
        <div className="composer__photos">
          {photos.map((photo, i) => (
            <div key={i} className="composer__photo">
              <img src={`data:${photo.mediaType};base64,${photo.data}`} alt="" />
              <button type="button" aria-label="Retirer la photo" onClick={() => setPhotos((current) => current.filter((_, j) => j !== i))}>
                <Icon name="close" size={12} stroke={2.6} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={field}
        className="composer__field"
        rows={1}
        value={text}
        placeholder={remote.busy ? "Message suivant…" : "Écris à ton agent…"}
        onChange={(e) => setText(e.target.value)}
        disabled={!ready}
      />
      <div className="composer__bar">
        {!rlm && (
          <button type="button" className="composer__icon" aria-label="Ajouter une photo" onClick={() => picker.current?.click()} disabled={!ready}>
            <Icon name="photo" size={21} />
          </button>
        )}
        <button type="button" className="chip" onClick={onOpenMode} disabled={!ready}>
          <Icon name={mode.icon} size={14} />
          {mode.label}
        </button>
        <button type="button" className="chip chip--model" onClick={onOpenModel} disabled={!ready}>
          {entry?.label ?? model?.name ?? "Modèle"}
          <span className="chip__sub">{THINKING_LABELS[thinkingOf(model)]}</span>
        </button>
        <span className="composer__spacer" />
        <button type="button" className="composer__icon" aria-label="Mode vocal" onClick={() => onVoice(true)} disabled={!ready}>
          <Icon name="mic" size={21} />
        </button>
        {showStop ? (
          <button type="button" className="send send--stop" aria-label="Arrêter l'agent" onClick={() => void remote.actions.stop()}>
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button type="button" className="send" aria-label="Envoyer" disabled={!canSend} onClick={() => void submit()}>
            {sending ? <Spinner size={16} /> : <Icon name="up" size={20} stroke={2.6} />}
          </button>
        )}
      </div>
      <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => void addPhotos(e.target.files).then(() => (e.target.value = ""))} />
    </div>
  );
}

export function ChatScreen({ remote, onBack }: { remote: Remote; onBack(): void }) {
  const conversation = remote.open;
  const summary = remote.conversations.find((c) => c.id === remote.currentId);
  const title = conversationTitle(conversation?.title || summary?.title);
  const rlm = summary?.harness === "rlm";
  const turn = remote.activeTurns.find((t) => t.conversationId === remote.currentId);
  const now = useNow(Boolean(turn));
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const readNext = useRef(false);
  const [voice, setVoice] = useState(false);

  const blocks = useMemo(
    () => (conversation ? [...blocksFromHistory(conversation.history), ...blocksFromEvents(remote.events)] : []),
    [conversation, remote.events],
  );
  const grouped = useMemo(() => groupBlocks(blocks), [blocks]);
  const last = blocks[blocks.length - 1];
  const streamingText = last?.kind === "text" && last.streaming;
  const plan = conversation?.planWorkflow.status === "planReady" ? conversation.planWorkflow.artifact : null;

  // Keep the newest content in view unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks, remote.queued, turn]);

  useEffect(() => {
    stick.current = true;
    setVoice(false);
  }, [remote.currentId]);

  // Read the report of a turn that ends while the app is open.
  useEffect(() => {
    if (turn) readNext.current = true;
  }, [turn]);
  useEffect(() => {
    if (!readNext.current || turn || !conversation) return;
    readNext.current = false;
    if (!remote.settings.readAloud && !voice) return;
    const lastText = [...conversation.history].reverse().find((m) => m.role === "assistant")?.parts.find((p) => p.type === "text");
    const spoken = lastText?.type === "text" ? extractSpoken(lastText.text) : null;
    if (spoken) speak(spoken);
  }, [conversation, turn, remote.settings.readAloud, voice]);

  const status = turn ? `L'agent travaille · ${duration(now - turn.startedAtMs)}` : voice ? "Mode vocal" : rlm ? "RLM" : undefined;

  return (
    <div className="screen chat" data-voice={voice || undefined}>
      <NavBar
        title={title}
        subtitle={status}
        left={<BackButton label="Retour" onClick={onBack} />}
        right={<NavButton icon="more" label="Actions" onClick={() => setMenuOpen(true)} disabled={!conversation} />}
      />
      <div
        ref={scroller}
        className="scroll chat__scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          stick.current = bottom;
          setAtBottom(bottom);
        }}
      >
        <ConnectionBanner connection={remote.connection} />
        {!conversation && (
          <div className="empty">
            <Spinner />
          </div>
        )}
        {conversation && blocks.length === 0 && !turn && (
          <div className="empty empty--chat">
            <Icon name={rlm ? "cube" : "bubble"} size={34} stroke={1.5} />
            <strong>Que doit faire ton agent ?</strong>
            <span>Il travaille sur ton Mac. Tu peux fermer l'app : une notification te prévient quand il a fini.</span>
          </div>
        )}
        {grouped.map((item, i) =>
          Array.isArray(item) ? (
            <div key={item[0].key} className="activity">
              {item.map((block) => (block.kind === "agent" ? <AgentRow key={block.key} block={block} /> : block.kind === "tool" ? <ToolRow key={block.key} block={block} /> : null))}
            </div>
          ) : (
            <Fragment key={item.key}>
              {item.kind === "user" && <UserBubble text={item.text} images={item.images} />}
              {item.kind === "text" && <AgentText text={item.text} streaming={item.streaming && i === grouped.length - 1} />}
              {item.kind === "thinking" && <Thinking text={item.text} streaming={item.streaming} />}
              {item.kind === "tool" &&
                (item.status === "running" ? (
                  <QuestionCard
                    block={item}
                    onAnswer={(answers) => remote.actions.answer(item.id, answers)}
                    onDismiss={() => remote.actions.dismissQuestion(item.id)}
                  />
                ) : (
                  <div className="activity">
                    <ToolRow block={item} />
                  </div>
                ))}
              {item.kind === "notice" && <Notice block={item} />}
            </Fragment>
          ),
        )}
        {turn && !streamingText && (
          <div className="working">
            <span className="working__dots">
              <i />
              <i />
              <i />
            </span>
            L'agent travaille…
          </div>
        )}
        {plan && !turn && (
          <div className="plan">
            <div className="plan__kicker">
              <Icon name="list" size={16} /> Plan prêt
            </div>
            <strong>{plan.title || plan.path.split("/").pop()}</strong>
            <div className="plan__actions">
              <button type="button" className="button" onClick={() => void remote.actions.runPlan(plan, false)}>
                Continuer à planifier
              </button>
              <button type="button" className="button button--primary" onClick={() => void remote.actions.runPlan(plan, true)}>
                Lancer le plan
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="chat__footer">
        {!atBottom && (
          <button
            type="button"
            className="to-bottom"
            aria-label="Aller en bas"
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            }}
          >
            <Icon name="down" size={18} stroke={2.4} />
          </button>
        )}
        <Composer key={remote.currentId} remote={remote} voice={voice} onVoice={setVoice} onOpenModel={() => setModelOpen(true)} onOpenMode={() => setModeOpen(true)} />
      </div>

      <ModelSheet remote={remote} open={modelOpen} onClose={() => setModelOpen(false)} />

      <Sheet open={modeOpen} title="Mode" onClose={() => setModeOpen(false)}>
        <div className="group__body">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className="row"
              onClick={() => {
                setModeOpen(false);
                void remote.actions.setMode(m.value);
              }}
            >
              <span className="row__icon" data-tone="mode">
                <Icon name={m.icon} size={18} />
              </span>
              <span className="row__text">
                <strong>{m.label}</strong>
                <span>{m.hint}</span>
              </span>
              {remote.mode === m.value && <span className="row__check"><Icon name="check" size={18} stroke={2.4} /></span>}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={menuOpen} title={title} onClose={() => setMenuOpen(false)}>
        <div className="group__body">
          <button
            type="button"
            className="row"
            disabled={Boolean(turn) || rlm}
            onClick={() => {
              setMenuOpen(false);
              void remote.actions.compact();
            }}
          >
            <span className="row__icon" data-tone="mode">
              <Icon name="compress" size={18} />
            </span>
            <span className="row__text">
              <strong>Compacter le contexte</strong>
              <span>Résume l'historique pour libérer de la place.</span>
            </span>
          </button>
          <button
            type="button"
            className="row row--danger"
            onClick={() => {
              setMenuOpen(false);
              if (conversation) void remote.actions.deleteConversation(conversation.id).then(onBack);
            }}
          >
            <span className="row__icon" data-tone="danger">
              <Icon name="trash" size={18} />
            </span>
            <span className="row__text">
              <strong>Supprimer la conversation</strong>
            </span>
          </button>
        </div>
      </Sheet>
    </div>
  );
}
