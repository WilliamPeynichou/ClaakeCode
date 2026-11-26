import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDictation } from "../dictation";
import { stopSpeaking } from "../speech";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/common";
import "./voice.css";

const CONSENT_KEY = "claake.voice.consent";
const BARS = 28;

type Props = {
  initialText: string;
  ready: boolean;
  onKeyboard(text: string): void;
  onSend(text: string): Promise<boolean>;
};

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** The composer in voice mode: a small dictaphone that records, shows the live transcript and sends it. */
export function VoicePanel({ initialText, ready, onKeyboard, onSend }: Props) {
  const dictation = useDictation(true, initialText);
  const [consent, setConsent] = useState(() => localStorage.getItem(CONSENT_KEY) === "1");
  const [sending, setSending] = useState(false);
  const [recorded, setRecorded] = useState({ total: 0, since: 0 });
  const [now, setNow] = useState(Date.now());
  const transcript = useRef<HTMLDivElement>(null);
  const listening = dictation.phase === "listening";
  const pending = [dictation.text, dictation.interim].join(" ").trim();
  const speaking = listening && now - dictation.heard < 900;

  function record() {
    stopSpeaking();
    dictation.start();
  }

  // Starts listening right away when the mic button opened the panel.
  useLayoutEffect(() => {
    if (consent && dictation.supported && ready) record();
  }, []);

  useEffect(() => {
    if (listening) {
      setRecorded((r) => ({ ...r, since: Date.now() }));
      const timer = window.setInterval(() => setNow(Date.now()), 200);
      return () => window.clearInterval(timer);
    }
    setRecorded((r) => (r.since ? { total: r.total + Date.now() - r.since, since: 0 } : r));
  }, [listening]);

  useLayoutEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pending]);

  function allow() {
    localStorage.setItem(CONSENT_KEY, "1");
    setConsent(true);
    record();
  }

  async function send() {
    const text = dictation.flush().trim();
    if (!text || sending) return;
    setSending(true);
    const sent = await onSend(text);
    setSending(false);
    dictation.setText(sent ? "" : text);
    if (sent) setRecorded({ total: 0, since: 0 });
  }

  const elapsed = recorded.total + (recorded.since ? now - recorded.since : 0);
  const state = speaking ? "speaking" : listening ? "listening" : "idle";
  const label =
    dictation.phase === "finishing" ? "Finalisation…" : listening ? "J'écoute" : pending ? "En pause" : "Touche le micro pour parler";

  if (!dictation.supported || !consent) {
    return (
      <div className="voice voice--notice">
        <p>
          {!dictation.supported
            ? "La dictée vocale n'est pas disponible dans l'app sur cet iPhone. Utilise le micro du clavier."
            : "Le mode vocal utilise la reconnaissance de Safari, qui peut envoyer ta voix aux serveurs d'Apple."}
        </p>
        <div className="voice__notice-actions">
          <button type="button" className="voice__ghost" onClick={() => onKeyboard(dictation.text)}>
            <Icon name="keyboard" size={17} /> Clavier
          </button>
          {dictation.supported && (
            <button type="button" className="voice__allow" onClick={allow} disabled={!ready}>
              <Icon name="mic" size={17} /> Activer le micro
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="voice" data-state={state}>
      <div className="voice__head">
        <span className="voice__led" aria-hidden />
        <span className="voice__time">{clock(elapsed)}</span>
        <span className="voice__label" role="status">{label}</span>
      </div>
      <div className="voice__wave" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} style={{ "--h": 0.3 + ((i * 37) % 11) / 15, "--d": `${(i * 53) % 640}ms` } as React.CSSProperties} />
        ))}
      </div>
      <div ref={transcript} className="voice__transcript">
        {pending ? (
          <>
            {dictation.text}
            {dictation.interim && <span className="voice__interim"> {dictation.interim}</span>}
          </>
        ) : (
          <span className="voice__placeholder">Ta transcription s'affiche ici.</span>
        )}
      </div>
      {dictation.error && <p className="voice__error">{dictation.error}</p>}
      <div className="voice__controls">
        <button type="button" className="voice__side" aria-label="Revenir au clavier" onClick={() => onKeyboard(dictation.flush())}>
          <Icon name="keyboard" size={20} />
        </button>
        <button
          type="button"
          className="voice__record"
          aria-label={listening ? "Mettre en pause" : "Parler"}
          disabled={!ready || dictation.phase === "finishing"}
          onClick={listening ? dictation.stop : record}
        >
          <Icon name={listening ? "pause" : "mic"} size={24} />
        </button>
        <button type="button" className="voice__side voice__send" aria-label="Envoyer" disabled={!ready || !pending || sending} onClick={() => void send()}>
          {sending ? <Spinner size={16} /> : <Icon name="up" size={20} stroke={2.6} />}
        </button>
      </div>
    </div>
  );
}
