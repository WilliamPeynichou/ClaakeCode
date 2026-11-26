import { useEffect, useRef, useState } from "react";

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

type RecognitionWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

type Phase = "idle" | "listening" | "finishing";

const joinSpeech = (base: string, speech: string) => [base.trimEnd(), speech.trim()].filter(Boolean).join(" ");

function recognitionError(code: string) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Le navigateur n’a pas autorisé la dictée. Vérifie l’accès au micro ou utilise le clavier.";
    case "audio-capture":
      return "Aucun micro n’est accessible. Essaie la dictée du clavier.";
    case "network":
      return "Le service vocal ne répond pas. Essaie la dictée du clavier.";
    case "no-speech":
      return "Aucune parole détectée. Tu peux réessayer.";
    default:
      return "La dictée a été interrompue. Tu peux réessayer ou utiliser le clavier.";
  }
}

export function useDictation(active: boolean, initialText = "") {
  const { SpeechRecognition, webkitSpeechRecognition } = window as RecognitionWindow;
  const Engine = SpeechRecognition ?? webkitSpeechRecognition;
  const [text, setText] = useState(initialText);
  const [interim, setInterim] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [heard, setHeard] = useState(0);
  const run = useRef<{ engine: Recognition; finish(): void; stop(): void; dispose(): void } | null>(null);

  useEffect(() => {
    const interrupt = () => run.current?.finish();
    const onVisibility = () => { if (document.hidden) interrupt(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", interrupt);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", interrupt);
      run.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!active) run.current?.finish();
  }, [active]);

  function start() {
    if (!active || !Engine || run.current) return;
    let engine: Recognition;
    try {
      engine = new Engine();
    } catch {
      setError(recognitionError(""));
      return;
    }
    engine.lang = "fr-FR";
    engine.continuous = true;
    engine.interimResults = true;
    let finalized = "";
    let partial = "";
    let stopTimer = 0;
    const base = text;

    function dispose(abort: boolean) {
      run.current = null;
      window.clearTimeout(stopTimer);
      engine.onresult = engine.onerror = engine.onend = null;
      if (abort) {
        try { engine.abort(); } catch { /* The recognition may already have ended. */ }
      }
    }

    function finish(abort = false) {
      if (run.current?.engine !== engine) return;
      dispose(abort);
      setText(joinSpeech(base, partial ? joinSpeech(finalized, partial) : finalized) || base);
      setInterim("");
      setPhase("idle");
    }

    engine.onresult = ({ results }) => {
      if (run.current?.engine !== engine) return;
      const chunks = Array.from(results);
      finalized = chunks.filter((chunk) => chunk.isFinal).map((chunk) => chunk[0].transcript.trim()).join(" ");
      partial = chunks.filter((chunk) => !chunk.isFinal).map((chunk) => chunk[0].transcript.trim()).join(" ");
      setText(joinSpeech(base, finalized) || base);
      setInterim(partial);
      setHeard(Date.now());
    };
    engine.onerror = ({ error: code }) => {
      setError(recognitionError(code));
      finish(true);
    };
    engine.onend = () => finish();
    run.current = {
      engine,
      finish: () => finish(true),
      dispose: () => dispose(true),
      stop() {
        setPhase("finishing");
        // Some browsers omit `end` if Stop is tapped while permission is opening.
        stopTimer = window.setTimeout(() => finish(true), 1500);
        try {
          engine.stop();
        } catch {
          finish(true);
        }
      },
    };
    setError("");
    setPhase("listening");
    try {
      engine.start();
    } catch (err) {
      setError(recognitionError(err instanceof DOMException && err.name === "NotAllowedError" ? "not-allowed" : ""));
      finish();
    }
  }

  function stop() {
    if (phase === "listening") run.current?.stop();
  }

  /** Ends recognition now and returns everything heard so far, including the unfinished phrase. */
  function flush() {
    const all = interim ? joinSpeech(text, interim) : text;
    run.current?.finish();
    return all;
  }

  return { supported: Boolean(Engine), text, setText, interim, phase, error, heard, start, stop, flush };
}
