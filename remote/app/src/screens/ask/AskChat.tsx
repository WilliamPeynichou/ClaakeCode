import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { askApi, type AskConversation, type AskDocument, type AskMessage, type Project } from "../../ask/api";
import { buildMessages, titleFrom } from "../../ask/context";
import { accountsChanged, allModels, streamModel, subscriptionLabel, type Model } from "../../ask/models";
import { defaultModel, saveDefaultModel } from "../../ask/openrouter";
import { UserBubble } from "../../chat/parts";
import { speak, speechSupported, stopSpeaking } from "../../speech";
import { BackButton, NavBar, NavButton, Spinner } from "../../ui/common";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { Sheet } from "../../ui/Sheet";
import { photoAttachment } from "../Chat";
import { VoicePanel } from "../Voice";

type Photo = { name: string; mediaType: string; base64: string };

const SUGGESTIONS = [
  { label: "Explique-moi un concept", text: "Explique-moi simplement comment fonctionne " },
  { label: "Relis un texte", text: "Relis ce texte et corrige-le : " },
  { label: "Prépare un plan", text: "Aide-moi à préparer un plan pour " },
];

function ModelSheet({ open, models, loaded, current, onClose, onChoose, onSettings }: {
  open: boolean;
  models: Model[];
  loaded: boolean;
  current: Model | undefined;
  onClose(): void;
  onChoose(model: Model): void;
  onSettings(): void;
}) {
  const [query, setQuery] = useState("");
  const [paid, setPaid] = useState(false);
  const needle = query.trim().toLowerCase();
  const match = (m: Model) => !needle || m.name.toLowerCase().includes(needle) || m.id.includes(needle);
  const groups = useMemo(() => {
    const out: { source: string; title: string; models: Model[] }[] = [];
    for (const m of models.filter((m) => m.source !== "openrouter" && match(m))) {
      const group = out.find((g) => g.source === m.source);
      if (group) group.models.push(m);
      else out.push({ source: m.source, title: subscriptionLabel(m.source), models: [m] });
    }
    return out;
  }, [models, needle]);
  const openrouter = useMemo(
    () => models.filter((m) => m.source === "openrouter" && (paid || m.free) && match(m)).slice(0, 80),
    [models, paid, needle],
  );
  const hasOpenrouter = models.some((m) => m.source === "openrouter");
  const row = (m: Model, detail: string) => (
    <button key={m.id} type="button" className="row row--compact" onClick={() => onChoose(m)}>
      <span className="row__text">
        <strong>{m.name}</strong>
        <span>{detail}</span>
      </span>
      {m.id === current?.id && <span className="row__check"><Icon name="check" size={18} stroke={2.4} /></span>}
    </button>
  );
  const traits = (m: Model) => `${m.images ? " · Images" : ""}${m.context ? ` · ${Math.round(m.context / 1000)}k` : ""}`;
  return (
    <Sheet open={open} title="Modèle" onClose={onClose}>
      <label className="search">
        <Icon name="search" size={17} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un modèle" type="search" />
      </label>
      {!loaded && (
        <div className="empty">
          <Spinner />
        </div>
      )}
      {groups.map((g) => (
        <section key={g.source} className="group">
          <h2 className="group__title">{g.title}</h2>
          <div className="group__body">{g.models.map((m) => row(m, `Ton abonnement${traits(m)}`))}</div>
        </section>
      ))}
      {hasOpenrouter && (
        <section className="group">
          <div className="group__head">
            <h2 className="group__title">OpenRouter</h2>
          </div>
          <div className="segmented" role="tablist">
            <button type="button" role="tab" aria-selected={!paid} data-on={!paid} onClick={() => setPaid(false)}>Gratuits</button>
            <button type="button" role="tab" aria-selected={paid} data-on={paid} onClick={() => setPaid(true)}>Tous</button>
          </div>
          <div className="group__body">{openrouter.map((m) => row(m, `${m.free ? "Gratuit" : "Payant"}${traits(m)}`))}</div>
          {!paid && <p className="group__footer">Les modèles gratuits d'OpenRouter ont une limite de messages par jour.</p>}
        </section>
      )}
      <section className="group">
        <div className="group__body">
          <button type="button" className="row row--compact ask-add" onClick={onSettings}>
            <Icon name="plus" size={18} />
            <span className="row__text"><strong>Connecter un abonnement</strong></span>
          </button>
        </div>
      </section>
    </Sheet>
  );
}

function AssistantMessage({ text, streaming }: { text: string; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const [playing, setPlaying] = useState(false);
  return (
    <div className="msg msg--agent" data-streaming={streaming ? "true" : "false"}>
      <Markdown text={text} />
      {!streaming && (
        <div className="ask-actions">
          <button
            type="button"
            aria-label="Copier"
            onClick={() => {
              void navigator.clipboard?.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }}
          >
            <Icon name={copied ? "check" : "doc"} size={15} />
          </button>
          {speechSupported() && (
            <button
              type="button"
              aria-label={playing ? "Arrêter la lecture" : "Écouter"}
              onClick={() => {
                if (playing) {
                  stopSpeaking();
                  setPlaying(false);
                } else {
                  setPlaying(true);
                  speak(text, () => setPlaying(false));
                }
              }}
            >
              <Icon name={playing ? "pause" : "speaker"} size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AskComposer({ voice, busy, model, onVoice, onModel, onSend, onStop, onError, draft }: {
  voice: boolean;
  busy: boolean;
  model: Model | undefined;
  onVoice(on: boolean): void;
  onModel(): void;
  onSend(text: string, photos: Photo[]): Promise<boolean>;
  onStop(): void;
  onError(err: unknown): void;
  draft: { text: string; at: number };
}) {
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const canSend = text.trim().length > 0 && !busy;

  useEffect(() => {
    if (!draft.at) return;
    setText(draft.text);
    field.current?.focus();
  }, [draft]);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  async function submit() {
    if (!canSend) return;
    const value = text.trim();
    const sent = photos;
    setText("");
    setPhotos([]);
    if (!(await onSend(value, sent))) {
      setText(value);
      setPhotos(sent);
    }
  }

  async function addPhotos(files: FileList | null) {
    try {
      const added = await Promise.all([...(files ?? [])].slice(0, 4).map(photoAttachment));
      setPhotos((current) => [...current, ...added.map((a) => ({ name: a.name, mediaType: a.mediaType, base64: a.data! }))].slice(0, 4));
    } catch (err) {
      onError(err);
    }
  }

  if (voice) {
    return (
      <div className="composer composer--voice">
        <VoicePanel
          initialText={text}
          ready={!busy}
          onKeyboard={(spoken) => {
            setText(spoken);
            onVoice(false);
          }}
          onSend={(spoken) => onSend(spoken, [])}
        />
      </div>
    );
  }

  return (
    <div className="composer">
      {photos.length > 0 && (
        <div className="composer__photos">
          {photos.map((photo, i) => (
            <div key={i} className="composer__photo">
              <img src={`data:${photo.mediaType};base64,${photo.base64}`} alt="" />
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
        placeholder="Demande à Claake…"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="composer__bar">
        <button type="button" className="composer__icon" aria-label="Ajouter une photo" onClick={() => picker.current?.click()} disabled={model ? !model.images : false}>
          <Icon name="photo" size={21} />
        </button>
        <button type="button" className="chip chip--model" onClick={onModel}>
          {model?.name ?? "Modèle"}
          {model?.free && <span className="chip__sub">Gratuit</span>}
        </button>
        <span className="composer__spacer" />
        <button type="button" className="composer__icon" aria-label="Mode vocal" onClick={() => onVoice(true)}>
          <Icon name="mic" size={21} />
        </button>
        {busy ? (
          <button type="button" className="send send--stop" aria-label="Arrêter" onClick={onStop}>
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button type="button" className="send" aria-label="Envoyer" disabled={!canSend} onClick={() => void submit()}>
            <Icon name="up" size={20} stroke={2.6} />
          </button>
        )}
      </div>
      <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => void addPhotos(e.target.files).then(() => (e.target.value = ""))} />
    </div>
  );
}

/** An Ask conversation. Without an id it is created on the first message, in `projectId` if given. */
export function AskChat({ conversationId, projectId, voiceOnly = false, active, onBack, onCreated, onNew, onSettings, onError }: {
  conversationId: string | null;
  projectId: string | null;
  voiceOnly?: boolean;
  active: boolean;
  onBack?(): void;
  onCreated?(conversation: AskConversation): void;
  onNew?(): void;
  onSettings(): void;
  onError(err: unknown): void;
}) {
  const [conversation, setConversation] = useState<AskConversation | null>(null);
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<AskDocument[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsVersion, setModelsVersion] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [voice, setVoice] = useState(voiceOnly);
  const [modelOpen, setModelOpen] = useState(false);
  const [draft, setDraft] = useState({ text: "", at: 0 });
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const busy = streaming !== null;
  const model = models.find((m) => m.id === (chosen ?? conversation?.model)) ?? (defaultModel(models) as Model | undefined);
  const projectIdNow = conversation?.projectId ?? projectId;

  useEffect(() => {
    if (!conversationId || conversation?.id === conversationId) return;
    setLoading(true);
    askApi
      .conversation(conversationId)
      .then((d) => {
        setConversation(d.conversation);
        setMessages(d.messages);
      })
      .catch(onError)
      .finally(() => setLoading(false));
  }, [conversationId]);

  useEffect(() => {
    if (!projectIdNow) return;
    askApi
      .project(projectIdNow)
      .then((d) => {
        setProject(d.project);
        setDocuments(d.documents);
      })
      .catch(onError);
  }, [projectIdNow]);

  useEffect(() => {
    const reload = () => setModelsVersion((v) => v + 1);
    accountsChanged.addEventListener("change", reload);
    return () => accountsChanged.removeEventListener("change", reload);
  }, []);
  useEffect(() => {
    allModels()
      .then(setModels)
      .catch(onError)
      .finally(() => setModelsLoaded(true));
  }, [modelsVersion]);

  useEffect(() => {
    if (!active) stopSpeaking();
  }, [active]);
  useEffect(() => () => abort.current?.abort(), []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  async function send(text: string, photos: Photo[]): Promise<boolean> {
    if (!model) {
      if (modelsLoaded) onSettings();
      else onError(new Error("La liste des modèles n'est pas encore chargée."));
      return false;
    }
    stopSpeaking();
    stick.current = true;
    setStreaming("");
    const before = messages;
    const controller = new AbortController();
    abort.current = controller;
    let partial = "";
    try {
      let current = conversation;
      if (!current) {
        current = await askApi.createConversation({ projectId, title: titleFrom(text), model: model.id });
        setConversation(current);
        onCreated?.(current);
      }
      const refs = await Promise.all(photos.map((p) => askApi.uploadDocument({ conversationId: current!.id }, p)));
      const pending: AskMessage = { id: "pending", role: "user", text, attachments: refs, model: null, createdAtMs: Date.now() };
      setMessages([...before, pending]);
      const request = await buildMessages({ project, documents, history: [...before, pending], model, voice });
      let reply: string;
      try {
        reply = await streamModel({
          model,
          messages: request,
          signal: controller.signal,
          onDelta: (t) => {
            partial = t;
            setStreaming(t);
          },
        });
      } catch (err) {
        if (!controller.signal.aborted) throw err;
        reply = partial;
      }
      if (!reply.trim() && !controller.signal.aborted) throw new Error("Le modèle n'a rien répondu. Réessaie ou change de modèle.");
      const saved = await askApi.appendMessages(current.id, [
        { role: "user", text, attachments: refs.map((r) => r.id) },
        ...(reply.trim() ? [{ role: "assistant" as const, text: reply, model: model.id }] : []),
      ]);
      setMessages([...before, ...saved]);
      if (voice && reply.trim() && !controller.signal.aborted) speak(reply.replace(/[*_`#>|]/g, ""));
      return true;
    } catch (err) {
      setMessages(before);
      onError(err);
      return false;
    } finally {
      abort.current = null;
      setStreaming(null);
    }
  }

  function choose(m: Model) {
    setChosen(m.id);
    saveDefaultModel(m.id);
    setModelOpen(false);
    if (conversation) void askApi.updateConversation(conversation.id, { model: m.id }).catch(onError);
  }

  const title = conversation?.title ?? (voiceOnly ? "Vocal" : "Nouvelle conversation");
  const subtitle = voice && !voiceOnly ? "Mode vocal" : project?.name ?? model?.name;
  const empty = !loading && messages.length === 0 && !busy;

  return (
    <div className="screen chat ask-chat" data-voice={voice || undefined}>
      <NavBar
        title={title}
        subtitle={subtitle}
        left={onBack ? <BackButton label="Retour" onClick={onBack} /> : undefined}
        right={onNew ? <NavButton icon="plus" label="Nouvelle conversation vocale" onClick={onNew} disabled={busy || messages.length === 0} /> : undefined}
      />
      <div
        ref={scroller}
        className="scroll chat__scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {loading && (
          <div className="empty">
            <Spinner />
          </div>
        )}
        {empty && voiceOnly && (
          <div className="empty empty--chat ask-voice-empty">
            <span className="ask-orb" aria-hidden="true"><i /><i /><i /></span>
            <strong>Parle, Claake t'écoute.</strong>
            <span>Touche le micro, pose ta question, puis envoie. La réponse est lue à voix haute.</span>
          </div>
        )}
        {empty && !voiceOnly && (
          <div className="empty empty--chat">
            <Icon name="sparkle" size={34} stroke={1.5} />
            <strong>{project ? `Projet ${project.name}` : "Que veux-tu savoir ?"}</strong>
            <span>
              {project
                ? documents.length
                  ? `Claake lit les ${documents.length} document${documents.length > 1 ? "s" : ""} du projet avant de répondre.`
                  : "Ajoute des documents au projet pour que Claake s'en serve."
                : "Pose une question, envoie une photo ou parle avec le micro."}
            </span>
            <div className="ask-suggestions">
              {(project && documents.length
                ? [{ label: "Résume les documents", text: "Résume les documents du projet en quelques points." }, ...SUGGESTIONS.slice(1)]
                : SUGGESTIONS
              ).map((s) => (
                <button key={s.label} type="button" className="chip" onClick={() => setDraft({ text: s.text, at: Date.now() })}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="ask-user">
              <UserBubble text={m.text} images={m.attachments.length} />
            </div>
          ) : (
            <AssistantMessage key={m.id} text={m.text} streaming={false} />
          ),
        )}
        {busy && streaming === "" && (
          <div className="working">
            <span className="working__dots">
              <i />
              <i />
              <i />
            </span>
            Claake réfléchit…
          </div>
        )}
        {busy && streaming && <AssistantMessage text={streaming} streaming />}
      </div>
      <div className="chat__footer">
        <AskComposer
          voice={voice}
          busy={busy}
          model={model}
          draft={draft}
          onVoice={setVoice}
          onModel={() => setModelOpen(true)}
          onSend={send}
          onStop={() => abort.current?.abort()}
          onError={onError}
        />
      </div>
      <ModelSheet
        open={modelOpen}
        models={models}
        loaded={modelsLoaded}
        current={model}
        onClose={() => setModelOpen(false)}
        onChoose={choose}
        onSettings={() => {
          setModelOpen(false);
          onSettings();
        }}
      />
    </div>
  );
}
