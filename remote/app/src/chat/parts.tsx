import { useMemo, useState } from "react";
import type { FileChange } from "../../../../src/types";
import { splitSpoken } from "../../../../src/lib/spoken";
import { speak, speechSupported, stopSpeaking } from "../speech";
import { Icon, type IconName } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { Spinner } from "../ui/common";
import { parseQuestions, type Block, type ToolBlock } from "./blocks";

export function UserBubble({ text, images }: { text: string; images: number }) {
  return (
    <div className="msg msg--user">
      <div className="bubble">
        {images > 0 && (
          <span className="bubble__attachment">
            <Icon name="photo" size={15} /> {images > 1 ? `${images} photos` : "Photo"}
          </span>
        )}
        {text}
      </div>
    </div>
  );
}

export function SynthesisCard({ text }: { text: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="synthesis">
      <div className="synthesis__head">
        <Icon name="speaker" size={16} />
        <span>Synthèse</span>
        {speechSupported() && (
          <button
            type="button"
            className="synthesis__play"
            aria-label={playing ? "Arrêter la lecture" : "Écouter la synthèse"}
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
            <Icon name={playing ? "pause" : "play"} size={14} />
            {playing ? "Stop" : "Écouter"}
          </button>
        )}
      </div>
      <p>{text}</p>
    </div>
  );
}

export function AgentText({ text, streaming }: { text: string; streaming: boolean }) {
  const { body, spoken, pending } = splitSpoken(text);
  return (
    <div className="msg msg--agent" data-streaming={streaming ? "true" : "false"}>
      {body && <Markdown text={body} />}
      {spoken && !pending && <SynthesisCard text={spoken} />}
    </div>
  );
}

export function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking" data-open={open ? "true" : "false"}>
      <button type="button" className="thinking__head" onClick={() => setOpen((v) => !v)} data-streaming={streaming ? "true" : "false"}>
        <Icon name="sparkle" size={15} />
        <span>{streaming ? "Réflexion…" : "Réflexion"}</span>
        <Icon name="down" size={13} stroke={2.4} />
      </button>
      {open && <div className="thinking__body"><Markdown text={text} /></div>}
    </div>
  );
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

export function toolInfo(block: ToolBlock): { icon: IconName; title: string } {
  const args = parseArgs(block.args);
  const s = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const file = basename(s("path") || s("file_path") || s("file"));
  switch (block.name.toLowerCase()) {
    case "read":
    case "read_file":
      return { icon: "doc", title: file ? `Lit ${file}` : "Lit un fichier" };
    case "edit_file":
    case "edit":
      return { icon: "pencil", title: file ? `Modifie ${file}` : "Modifie un fichier" };
    case "write_file":
    case "write":
      return { icon: "pencil", title: file ? `Écrit ${file}` : "Écrit un fichier" };
    case "grep":
      return { icon: "search", title: s("pattern") ? `Cherche « ${s("pattern")} »` : "Cherche dans le code" };
    case "glob":
      return { icon: "folder", title: s("pattern") ? `Liste ${s("pattern")}` : "Liste des fichiers" };
    case "bash":
    case "powershell":
      return { icon: "terminal", title: s("description") || s("command") || "Commande" };
    case "bash_input":
      return { icon: "terminal", title: "Terminal" };
    case "python":
    case "ipython":
      return { icon: "terminal", title: s("description") || "Python" };
    case "web_search":
      return { icon: "globe", title: s("query") ? `Web : ${s("query")}` : "Recherche web" };
    case "web_fetch":
      return { icon: "globe", title: s("url") ? `Lit ${s("url").replace(/^https?:\/\//, "")}` : "Lit une page web" };
    case "todo_list":
      return { icon: "list", title: "Met à jour les tâches" };
    case "question":
      return { icon: "ask", title: "Question" };
    case "agent":
    case "team_run":
    case "team_create":
      return { icon: "agent", title: s("description") || "Lance des agents" };
    case "skill":
      return { icon: "sparkle", title: s("name") ? `Skill ${s("name")}` : "Skill" };
    case "context_compaction":
    case "clean_context":
      return { icon: "compress", title: "Allège le contexte" };
    default:
      return { icon: "cube", title: block.name.replace(/_/g, " ") };
  }
}

function Diff({ change }: { change: FileChange }) {
  const [all, setAll] = useState(false);
  const lines = all ? change.lines : change.lines.slice(0, 40);
  return (
    <div className="diff">
      <div className="diff__head">
        <span>{change.relativePath}</span>
        <span className="diff__stats">
          <span className="plus">+{change.addedLines ?? 0}</span> <span className="minus">−{change.removedLines ?? 0}</span>
        </span>
      </div>
      {!change.binary && lines.length > 0 && (
        <pre className="diff__lines">
          {lines.map((line, i) => (
            <span key={i} data-kind={line.kind}>
              {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "} {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      {!all && change.lines.length > 40 && (
        <button type="button" className="diff__more" onClick={() => setAll(true)}>
          Voir les {change.lines.length - 40} lignes suivantes
        </button>
      )}
    </div>
  );
}

export function ToolRow({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const { icon, title } = toolInfo(block);
  const added = block.files.reduce((sum, f) => sum + (f.addedLines ?? 0), 0);
  const removed = block.files.reduce((sum, f) => sum + (f.removedLines ?? 0), 0);
  const command = parseArgs(block.args).command;
  return (
    <div className="tool" data-status={block.status} data-open={open ? "true" : "false"}>
      <button type="button" className="tool__head" onClick={() => setOpen((v) => !v)}>
        <span className="tool__icon">
          <Icon name={icon} size={16} />
        </span>
        <span className="tool__title">{title}</span>
        {block.files.length > 0 && (
          <span className="tool__stats">
            <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
          </span>
        )}
        <span className="tool__status">
          {block.status === "running" ? <Spinner size={14} /> : block.status === "error" ? <Icon name="warning" size={15} /> : null}
        </span>
      </button>
      {open && (
        <div className="tool__body">
          {block.files.map((change) => (
            <Diff key={change.relativePath} change={change} />
          ))}
          {typeof command === "string" && <pre className="code">$ {command}</pre>}
          {block.files.length === 0 && typeof command !== "string" && block.args && block.args !== "{}" && <pre className="code">{block.args}</pre>}
          {block.output && <pre className="code code--output">{block.output}</pre>}
          {!block.output && block.status === "running" && <p className="tool__wait">En cours…</p>}
        </div>
      )}
    </div>
  );
}

export function QuestionCard({
  block,
  onAnswer,
  onDismiss,
}: {
  block: ToolBlock;
  onAnswer(answers: string[][]): Promise<void>;
  onDismiss(): Promise<void>;
}) {
  const questions = useMemo(() => parseQuestions(block.args), [block.args]);
  const [selected, setSelected] = useState<Record<number, number[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);

  if (questions.length === 0) {
    return (
      <div className="question">
        <div className="question__kicker">
          <Spinner size={14} /> L'agent prépare une question…
        </div>
      </div>
    );
  }

  const answers = questions.map((q, i) => {
    const labels = (selected[i] ?? []).map((index) => q.options[index]?.label).filter((v): v is string => Boolean(v));
    const extra = (custom[i] ?? "").trim();
    return extra ? [...labels, extra] : labels;
  });
  const complete = answers.every((a) => a.length > 0);

  const toggle = (qi: number, oi: number, multiple: boolean) =>
    setSelected((current) => {
      const list = current[qi] ?? [];
      const next = multiple ? (list.includes(oi) ? list.filter((v) => v !== oi) : [...list, oi]) : [oi];
      return { ...current, [qi]: next };
    });

  const run = async (action: () => Promise<void>) => {
    setSending(true);
    try {
      await action();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="question">
      <div className="question__kicker">
        <Icon name="ask" size={16} /> L'agent te pose {questions.length > 1 ? "des questions" : "une question"}
      </div>
      {questions.map((q, qi) => (
        <div key={qi} className="question__group">
          <p className="question__title">{q.question}</p>
          {q.multiple && <p className="question__hint">Plusieurs choix possibles.</p>}
          <div className="question__options">
            {q.options.map((option, oi) => {
              const on = (selected[qi] ?? []).includes(oi);
              return (
                <button key={oi} type="button" className="option" data-on={on ? "true" : "false"} onClick={() => toggle(qi, oi, q.multiple)}>
                  <span className="option__mark" data-multiple={q.multiple ? "true" : "false"}>
                    {on && <Icon name="check" size={13} stroke={3} />}
                  </span>
                  <span className="option__text">
                    <strong>{option.label}</strong>
                    {option.description && <span>{option.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <input
            className="question__other"
            placeholder={q.options.length > 0 ? "Autre réponse…" : "Ta réponse…"}
            value={custom[qi] ?? ""}
            onChange={(e) => setCustom((current) => ({ ...current, [qi]: e.target.value }))}
          />
        </div>
      ))}
      <div className="question__actions">
        <button type="button" className="button" disabled={sending} onClick={() => void run(onDismiss)}>
          Ignorer
        </button>
        <button type="button" className="button button--primary" disabled={!complete || sending} onClick={() => void run(() => onAnswer(answers))}>
          {sending ? "Envoi…" : "Répondre"}
        </button>
      </div>
    </div>
  );
}

export function Notice({ block }: { block: Extract<Block, { kind: "notice" }> }) {
  return (
    <div className="notice" data-tone={block.tone}>
      <Icon name={block.tone === "error" ? "warning" : "bolt"} size={15} />
      <span>{block.text}</span>
    </div>
  );
}

export function AgentRow({ block }: { block: Extract<Block, { kind: "agent" }> }) {
  return (
    <div className="tool" data-status={block.status}>
      <div className="tool__head">
        <span className="tool__icon">
          <Icon name="agent" size={16} />
        </span>
        <span className="tool__title">Agent {block.name}</span>
        <span className="tool__status">{block.status === "running" ? <Spinner size={14} /> : block.status === "error" ? <Icon name="warning" size={15} /> : null}</span>
      </div>
    </div>
  );
}
