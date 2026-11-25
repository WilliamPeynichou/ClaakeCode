import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./ipc";
import { extractSpoken } from "./spoken";
import {
  PARTIAL_EVERY_MS,
  PRE_ROLL_MS,
  PhraseDetector,
  detectLanguage,
  interpretTranscript,
  joinDraft,
  resampleTo16k,
  rms,
  micErrorMessage,
  type VoiceCommand,
} from "./voiceLogic";

/** macOS: "apple" (on-device Speech), "apple-server" (Apple servers allowed); else Whisper. */
export type VoiceEngine = "apple" | "apple-server" | "whisper";
const ENGINE_KEY = "claake.voiceEngine";

export function readVoiceEngine(): VoiceEngine {
  const saved = localStorage.getItem(ENGINE_KEY);
  return saved === "apple-server" || saved === "whisper" ? saved : "apple";
}

export function saveVoiceEngine(engine: VoiceEngine) {
  localStorage.setItem(ENGINE_KEY, engine);
}

/** Confirms and downloads the local speech model if missing. False when the user declines. */
export async function ensureDictationModel(onProgress?: (fraction: number) => void): Promise<boolean> {
  const status = await api.dictationModelStatus();
  if (status.installed) return true;
  const mb = Math.round(status.sizeBytes / 1_000_000);
  const ok = window.confirm(
    `Voice runs locally and needs a one-time download of the speech model (about ${mb} MB). Download it now?`,
  );
  if (!ok) return false;
  onProgress?.(0);
  const unlisten = await listen<{ received: number; total: number }>(
    "dictation-model-progress",
    (e) => onProgress?.(e.payload.total > 0 ? e.payload.received / e.payload.total : 0),
  );
  try {
    await api.dictationDownloadModel();
  } finally {
    unlisten();
  }
  return true;
}

export type VoicePhase = "off" | "starting" | "listening" | "muted" | "hearing" | "transcribing" | "speaking";

type Options = {
  isBusy: boolean;
  lastAssistantText: () => string | null;
  send: (text: string) => void | Promise<void>;
  stop: () => void | Promise<void>;
  vocabulary?: () => string;
  /** Current composer text, kept at the start of the spoken message. */
  composerText: () => string;
  /** Shows the live transcript in the composer ("" once the message is sent). */
  onDraft: (text: string) => void;
};

function beep(ctx: AudioContext, freqs: number[]) {
  const t0 = ctx.currentTime;
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const at = t0 + i * 0.14;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.06, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.12);
  });
}

function concat(frames: Float32Array[]): Float32Array {
  const merged = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    merged.set(f, offset);
    offset += f.length;
  }
  return merged;
}

function pickVoice(lang: "fr" | "en"): SpeechSynthesisVoice | undefined {
  return window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
}

export function useVoiceMode(opts: Options) {
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const phaseRef = useRef<VoicePhase>("off");
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const lastSpokenRef = useRef<string | null>(null);
  const resourcesRef = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    node: ScriptProcessorNode;
    source: MediaStreamAudioSourceNode;
  } | null>(null);
  const detectorRef = useRef(new PhraseDetector());
  const preRollRef = useRef<Float32Array[]>([]);
  const phraseRef = useRef<Float32Array[]>([]);
  const generationRef = useRef(0);
  const inFlightRef = useRef(0);
  const messageRef = useRef(0);
  const draftShownRef = useRef(-1);
  const baseRef = useRef("");
  const chunksRef = useRef<Promise<string>[]>([]);
  const chunkTextsRef = useRef<string[]>([]);
  const sincePartialMsRef = useRef(0);
  const partialBusyRef = useRef(false);
  const engineRef = useRef<"apple" | "whisper">("whisper");
  const allowServerRef = useRef(false);
  const speechChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const speechIdRef = useRef<number | null>(null);
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const needsChoiceRef = useRef(false);
  const [needsChoice, setNeedsChoice] = useState(false);

  const changePhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const idlePhase = useCallback(() => (mutedRef.current ? "muted" : "listening"), []);

  const resetCapture = useCallback(() => {
    detectorRef.current.reset();
    preRollRef.current = [];
    phraseRef.current = [];
    setLevel(0);
  }, []);

  const resumeListening = useCallback(
    (sound = true) => {
      resetCapture();
      changePhase(idlePhase());
      const res = resourcesRef.current;
      if (sound && res && !mutedRef.current && !deafenedRef.current) beep(res.ctx, [660]);
    },
    [changePhase, idlePhase, resetCapture],
  );

  const speak = useCallback(
    (text: string) => {
      if (!canSpeak) return resumeListening();
      lastSpokenRef.current = text;
      window.speechSynthesis.cancel();
      const lang = detectLanguage(text);
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang === "fr" ? "fr-FR" : "en-US";
      const voice = pickVoice(lang);
      if (voice) utterance.voice = voice;
      const generation = generationRef.current;
      const done = () => {
        if (generation === generationRef.current && phaseRef.current === "speaking") resumeListening();
      };
      utterance.onend = done;
      utterance.onerror = done;
      resetCapture();
      changePhase("speaking");
      window.speechSynthesis.speak(utterance);
    },
    [canSpeak, changePhase, resetCapture, resumeListening],
  );

  const stopSpeaking = useCallback(() => {
    if (phaseRef.current !== "speaking") return;
    window.speechSynthesis.cancel();
    resumeListening();
  }, [resumeListening]);

  const repeat = useCallback(() => {
    if (lastSpokenRef.current && !deafenedRef.current) speak(lastSpokenRef.current);
  }, [speak]);

  /** Explicit request (▶ on a report card): plays even when sound is off. */
  const read = useCallback(
    (text: string) => {
      if (phaseRef.current !== "off" && phaseRef.current !== "starting") speak(text);
    },
    [speak],
  );

  const toggleDeafen = useCallback(() => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    setDeafened(next);
    if (next && phaseRef.current === "speaking") {
      window.speechSynthesis.cancel();
      resumeListening(false);
    }
  }, [resumeListening]);

  const release = useCallback(() => {
    generationRef.current += 1;
    if (canSpeak) window.speechSynthesis.cancel();
    const res = resourcesRef.current;
    resourcesRef.current = null;
    if (res) {
      res.node.onaudioprocess = null;
      res.node.disconnect();
      res.source.disconnect();
      res.stream.getTracks().forEach((t) => t.stop());
      void res.ctx.close();
    }
    unlistenRef.current.forEach((unlisten) => unlisten());
    unlistenRef.current = [];
    if (engineRef.current === "apple") {
      speechIdRef.current = null;
      void api.speechCancel().catch(() => {});
    }
    resetCapture();
  }, [canSpeak, resetCapture]);

  const exit = useCallback(() => {
    release();
    setError(null);
    mutedRef.current = false;
    setMuted(false);
    deafenedRef.current = false;
    setDeafened(false);
    needsChoiceRef.current = false;
    setNeedsChoice(false);
    setModelProgress(null);
    changePhase("off");
  }, [changePhase, release]);

  const runCommand = useCallback(
    (command: VoiceCommand) => {
      if (command === "stop") void optsRef.current.stop();
      else if (command === "repeat") repeat();
      else exit();
    },
    [exit, repeat],
  );

  const transcribeText = useCallback(async (samples: Float32Array) => {
    const vocabulary = optsRef.current.vocabulary?.();
    return (await api.transcribeAudio(samples, vocabulary || undefined)).text;
  }, []);

  /** Puts `voiceText` in the composer after the text typed before speaking. */
  const showDraft = useCallback((voiceText: string) => {
    draftShownRef.current = messageRef.current;
    optsRef.current.onDraft(joinDraft(baseRef.current, voiceText));
  }, []);

  /** Drops the phrase being heard and gives the composer back its typed text. */
  const abandonPhrase = useCallback(() => {
    if (draftShownRef.current === messageRef.current) optsRef.current.onDraft(baseRef.current);
    messageRef.current += 1;
  }, []);

  /** Runs Speech-framework calls in order: start, pushes, then finish or cancel. */
  const queueSpeech = useCallback(<T,>(call: () => Promise<T>) => {
    const next = speechChainRef.current.then(call);
    speechChainRef.current = next.catch(() => {});
    return next;
  }, []);

  const onSpeechFailure = useCallback(
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      if (message === "dictation_disabled") {
        abandonPhrase();
        speechIdRef.current = null;
        void queueSpeech(() => api.speechCancel());
        needsChoiceRef.current = true;
        setNeedsChoice(true);
      } else if (message === "speech_denied") {
        setError(
          "Reconnaissance vocale refusée : autorise Claake Code dans Réglages Système › Confidentialité et sécurité › Reconnaissance vocale.",
        );
      } else if (message === "speech_unavailable") {
        setError("La reconnaissance vocale de macOS n'est pas disponible pour le moment.");
      } else {
        setError(message);
      }
    },
    [abandonPhrase, queueSpeech],
  );

  const pushSpeech = useCallback(
    (frames: Float32Array[], sampleRate: number) => {
      const samples = resampleTo16k(concat(frames), sampleRate);
      void queueSpeech(() => api.speechPush(samples));
    },
    [queueSpeech],
  );

  const finalize = useCallback(
    async (base: string, transcript: Promise<string>, message: number) => {
      const generation = generationRef.current;
      inFlightRef.current += 1;
      try {
        const text = await transcript;
        if (generation !== generationRef.current) return;
        // A new phrase may already own the composer: only touch it if not.
        const ownsComposer = messageRef.current === message;
        const input = interpretTranscript(text);
        if (input.kind === "message") {
          void optsRef.current.send(joinDraft(base, input.text));
          if (ownsComposer) optsRef.current.onDraft("");
        } else {
          if (ownsComposer) optsRef.current.onDraft(base);
          if (input.kind === "command") {
            runCommand(input.command);
            if (input.command === "exit") return;
            if (input.command === "repeat" && phaseRef.current === "speaking") return;
          }
        }
      } catch (e) {
        if (generation !== generationRef.current) return;
        if (messageRef.current === message) optsRef.current.onDraft(base);
        onSpeechFailure(e);
      } finally {
        inFlightRef.current -= 1;
      }
      if (generation === generationRef.current && inFlightRef.current === 0 && phaseRef.current === "transcribing") {
        resumeListening(false);
      }
    },
    [onSpeechFailure, resumeListening, runCommand],
  );

  const partial = useCallback(
    (samples: Float32Array) => {
      const generation = generationRef.current;
      const message = messageRef.current;
      partialBusyRef.current = true;
      void transcribeText(samples)
        .then((text) => {
          if (generation !== generationRef.current || message !== messageRef.current) return;
          showDraft(joinDraft(...chunkTextsRef.current, text));
        })
        .catch(() => {})
        .finally(() => {
          partialBusyRef.current = false;
        });
    },
    [showDraft, transcribeText],
  );

  const onFrame = useCallback(
    (input: Float32Array, sampleRate: number) => {
      const current = phaseRef.current;
      if (mutedRef.current || needsChoiceRef.current) return;
      if (current !== "listening" && current !== "hearing" && current !== "transcribing") return;
      const apple = engineRef.current === "apple";
      const frame = new Float32Array(input);
      const frameMs = (frame.length / sampleRate) * 1000;
      const levelNow = rms(frame);
      setLevel(Math.min(1, levelNow * 8));
      const event = detectorRef.current.push(levelNow, frameMs);
      if (event === "start") {
        messageRef.current += 1;
        // While the previous message is still being transcribed, the composer shows its draft.
        baseRef.current = inFlightRef.current > 0 ? "" : optsRef.current.composerText();
        chunksRef.current = [];
        chunkTextsRef.current = [];
        sincePartialMsRef.current = 0;
        phraseRef.current = [...preRollRef.current, frame];
        changePhase("hearing");
        if (apple) {
          const message = messageRef.current;
          speechIdRef.current = null;
          const vocabulary = optsRef.current.vocabulary?.() || undefined;
          void queueSpeech(() => api.speechStart(vocabulary, allowServerRef.current))
            .then((id) => {
              if (message === messageRef.current) speechIdRef.current = id;
            })
            .catch(onSpeechFailure);
          pushSpeech(phraseRef.current, sampleRate);
        }
        return;
      }
      if (!detectorRef.current.inPhrase && event === null) {
        preRollRef.current.push(frame);
        const keep = Math.ceil(PRE_ROLL_MS / frameMs);
        if (preRollRef.current.length > keep) preRollRef.current.splice(0, preRollRef.current.length - keep);
        return;
      }
      phraseRef.current.push(frame);
      if (apple) {
        if (event === "end") {
          pushSpeech([frame], sampleRate);
          speechIdRef.current = null;
          resetCapture();
          changePhase("transcribing");
          void finalize(baseRef.current, queueSpeech(() => api.speechFinish()), messageRef.current);
        } else if (event === "discard") {
          speechIdRef.current = null;
          void queueSpeech(() => api.speechCancel());
          abandonPhrase();
          resetCapture();
          changePhase(inFlightRef.current > 0 ? "transcribing" : idlePhase());
        } else {
          // One request covers the whole phrase, so "split" needs nothing here.
          pushSpeech([frame], sampleRate);
        }
        return;
      }
      if (event === "split") {
        const index = chunksRef.current.length;
        const chunk = transcribeText(resampleTo16k(concat(phraseRef.current), sampleRate))
          .then((text) => (chunkTextsRef.current[index] = text))
          .catch(() => "");
        chunksRef.current.push(chunk);
        phraseRef.current = [];
        sincePartialMsRef.current = 0;
      } else if (event === "end") {
        const samples = resampleTo16k(concat(phraseRef.current), sampleRate);
        const transcript = Promise.all([...chunksRef.current, transcribeText(samples)]).then((parts) =>
          joinDraft(...parts),
        );
        resetCapture();
        changePhase("transcribing");
        void finalize(baseRef.current, transcript, messageRef.current);
      } else if (event === "discard") {
        abandonPhrase();
        resetCapture();
        changePhase(inFlightRef.current > 0 ? "transcribing" : idlePhase());
      } else {
        sincePartialMsRef.current += frameMs;
        if (sincePartialMsRef.current >= PARTIAL_EVERY_MS && !partialBusyRef.current && inFlightRef.current === 0) {
          sincePartialMsRef.current = 0;
          partial(resampleTo16k(concat(phraseRef.current), sampleRate));
        }
      }
    },
    [abandonPhrase, changePhase, finalize, idlePhase, onSpeechFailure, partial, pushSpeech, queueSpeech, resetCapture, transcribeText],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== "off") return;
    setError(null);
    changePhase("starting");
    try {
      const engine = readVoiceEngine();
      const apple = engine !== "whisper" && (await api.speechSupported());
      engineRef.current = apple ? "apple" : "whisper";
      allowServerRef.current = engine === "apple-server";
      if (apple) {
        unlistenRef.current = [
          await listen<{ id: number; text: string }>("speech-partial", (e) => {
            if (e.payload.id === speechIdRef.current) showDraft(e.payload.text);
          }),
          await listen<{ id: number; code: string }>("speech-error", (e) => {
            if (e.payload.id === speechIdRef.current) onSpeechFailure(new Error(e.payload.code));
          }),
        ];
      } else {
        const ready = await ensureDictationModel(setModelProgress);
        setModelProgress(null);
        if (!ready) return changePhase("off");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext();
      // Created after awaits, so outside the click gesture: WebKit may start it suspended.
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0), ctx.sampleRate);
      source.connect(node);
      node.connect(ctx.destination);
      resourcesRef.current = { stream, ctx, node, source };
      resumeListening();
    } catch (e) {
      release();
      setModelProgress(null);
      setError(micErrorMessage(e));
      changePhase("off");
    }
  }, [changePhase, onFrame, onSpeechFailure, release, resumeListening, showDraft]);

  /** Answer to "Dictation is disabled": open Settings, allow Apple servers, or use Whisper. */
  const chooseEngine = useCallback(
    (choice: "settings" | "apple-server" | "whisper") => {
      needsChoiceRef.current = false;
      setNeedsChoice(false);
      if (choice === "settings") {
        void api.speechOpenSettings();
      } else if (choice === "apple-server") {
        saveVoiceEngine("apple-server");
        allowServerRef.current = true;
      } else {
        saveVoiceEngine("whisper");
        exit();
        void start();
      }
    },
    [exit, start],
  );

  const toggleMute = useCallback(() => {
    if (phaseRef.current === "off" || phaseRef.current === "starting") return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (detectorRef.current.inPhrase) abandonPhrase();
    resetCapture();
    const current = phaseRef.current;
    if (current === "listening" || current === "hearing" || current === "muted") changePhase(next ? "muted" : "listening");
  }, [abandonPhrase, changePhase, resetCapture]);

  const wasBusyRef = useRef(opts.isBusy);
  useEffect(() => {
    const was = wasBusyRef.current;
    wasBusyRef.current = opts.isBusy;
    if (!was || opts.isBusy) return;
    const res = resourcesRef.current;
    if (!res || phaseRef.current === "off" || phaseRef.current === "starting") return;
    const text = optsRef.current.lastAssistantText();
    const spoken = text ? extractSpoken(text) : null;
    // An interrupted turn may end without a new report: never re-read the previous one.
    const fresh = spoken && spoken !== lastSpokenRef.current ? spoken : null;
    if (deafenedRef.current) {
      if (fresh) lastSpokenRef.current = fresh;
      return;
    }
    beep(res.ctx, [660, 880]);
    if (fresh) speak(fresh);
  }, [opts.isBusy, speak]);

  useEffect(() => {
    if (phase === "off") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        toggleMute();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        toggleDeafen();
      } else if (e.key === "Escape" && phaseRef.current === "speaking") {
        e.preventDefault();
        stopSpeaking();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, stopSpeaking, toggleDeafen, toggleMute]);

  useEffect(() => release, [release]);

  return {
    active: phase !== "off",
    phase,
    muted,
    deafened,
    level,
    error,
    modelProgress,
    canSpeak,
    start,
    exit,
    toggleMute,
    toggleDeafen,
    stopSpeaking,
    repeat,
    read,
    needsChoice,
    chooseEngine,
  };
}
