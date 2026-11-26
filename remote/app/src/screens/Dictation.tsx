import { useEffect, useRef, useState } from "react";
import { useDictation } from "../dictation";
import { Icon } from "../ui/Icon";
import { BackButton, NavBar } from "../ui/common";
import "./dictation.css";

type Props = {
  active: boolean;
  canOpenChat: boolean;
  onBack(): void;
  onUse(text: string): Promise<void>;
};

export function DictationScreen({ active, canOpenChat, onBack, onUse }: Props) {
  const dictation = useDictation(active);
  const [allowBrowser, setAllowBrowser] = useState(false);
  const [opening, setOpening] = useState(false);
  const editor = useRef<HTMLElement>(null);
  const working = dictation.phase !== "idle";
  const value = dictation.interim ? [dictation.text.trimEnd(), dictation.interim].filter(Boolean).join(" ") : dictation.text;
  const text = dictation.text.trim();

  useEffect(() => {
    const target = editor.current;
    if (!target || !("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      target.dataset.revealed = "true";
      observer.disconnect();
    }, { threshold: 0.1 });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  async function openChat() {
    if (!text || !canOpenChat || working || opening) return;
    setOpening(true);
    try {
      await onUse(text);
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="screen dictation">
      <NavBar title="Dictée" left={<BackButton label="Conversations" onClick={onBack} />} />
      <div className="scroll dictation__scroll">
        <header className="dictation__intro">
          <h1>Dictée</h1>
          <p>Parle, corrige le texte, puis utilise-le dans un nouveau chat.</p>
        </header>
        {dictation.supported && (
          <section className="dictation__mic" aria-label="Reconnaissance vocale">
            <div className="dictation__controls">
              <button
                type="button"
                className="dictation__record"
                disabled={dictation.phase === "finishing" || (!working && !allowBrowser)}
                onClick={working ? dictation.stop : dictation.start}
              >
                <Icon name={working ? "stop" : "mic"} size={19} />
                {dictation.phase === "finishing" ? "Finalisation…" : working ? "Arrêter" : "Dicter"}
              </button>
              <span className="dictation__status" role="status">
                {dictation.phase === "listening" ? "Micro actif · Français" : dictation.phase === "finishing" ? "Micro en cours d’arrêt" : "Micro coupé · Français"}
              </span>
            </div>
            {!working && (
              <label className="dictation__consent">
                <input type="checkbox" checked={allowBrowser} onChange={(event) => setAllowBrowser(event.target.checked)} />
                <span>J’autorise la dictée du navigateur. Il peut traiter ma voix sur ses serveurs.</span>
              </label>
            )}
          </section>
        )}
        <section className="dictation__editor" aria-label="Transcription" ref={editor}>
          <label htmlFor="dictation-transcript">Transcription</label>
          <textarea
            id="dictation-transcript"
            placeholder="Ton texte apparaîtra ici…"
            value={value}
            readOnly={working || opening}
            onChange={(event) => dictation.setText(event.target.value)}
          />
          {dictation.error && <p className="dictation__error" role="status">{dictation.error}</p>}
          <p className="dictation__hint">
            {dictation.supported ? "Tu peux aussi utiliser le micro du clavier de ton iPhone." : "La dictée du navigateur n’est pas disponible ici. Touche le champ et utilise le micro du clavier de ton iPhone."}
          </p>
          <button type="button" className="dictation__use" disabled={!text || !canOpenChat || working || opening} onClick={() => void openChat()}>
            {opening ? "Ouverture…" : "Utiliser dans un nouveau chat"}
            <Icon name="chevron" size={15} />
          </button>
          {!canOpenChat && <p className="dictation__hint">Connecte ton Mac pour ouvrir un chat.</p>}
        </section>
      </div>
    </div>
  );
}
