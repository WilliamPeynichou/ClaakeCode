import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./ipc";
import { ensureDictationModel } from "./useDictation";
import { extractSpoken } from "./spoken";
import {
  PRE_ROLL_MS,
  PhraseDetector,
  detectLanguage,
  interpretTranscript,
  resampleTo16k,
  rms,
  micErrorMessage,
  type VoiceCommand,
} from "./voiceLogic";

export type VoicePhase = "off" | "starting" | "listening" | "muted" | "hearing" | "transcribing" | "speaking";

type Options = {
  isBusy: boolean;
  lastAssistantText: () => string | null;
  send: (text: string) => void | Promise<void>;
  stop: () => void | Promise<void>;
  vocabulary?: () => string;
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
    resetCapture();
  }, [canSpeak, resetCapture]);

  const exit = useCallback(() => {
    release();
    setError(null);
    mutedRef.current = false;
    setMuted(false);
    deafenedRef.current = false;
    setDeafened(false);
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

  const transcribe = useCallback(
    async (samples: Float32Array) => {
      const generation = generationRef.current;
      inFlightRef.current += 1;
      try {
        const vocabulary = optsRef.current.vocabulary?.();
        const { text } = await api.transcribeAudio(samples, vocabulary || undefined);
        if (generation !== generationRef.current) return;
        const input = interpretTranscript(text);
        if (input.kind === "command") {
          runCommand(input.command);
          if (input.command === "exit") return;
          if (input.command === "repeat" && phaseRef.current === "speaking") return;
        } else if (input.kind === "message") {
          void optsRef.current.send(input.text);
        }
      } catch (e) {
        if (generation !== generationRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlightRef.current -= 1;
      }
      if (generation === generationRef.current && inFlightRef.current === 0 && phaseRef.current === "transcribing") {
        resumeListening(false);
      }
    },
    [changePhase, resumeListening, runCommand],
  );

  const onFrame = useCallback(
    (input: Float32Array, sampleRate: number) => {
      const current = phaseRef.current;
      if (mutedRef.current || (current !== "listening" && current !== "hearing" && current !== "transcribing")) return;
      const frame = new Float32Array(input);
      const frameMs = (frame.length / sampleRate) * 1000;
      const levelNow = rms(frame);
      setLevel(Math.min(1, levelNow * 8));
      const event = detectorRef.current.push(levelNow, frameMs);
      if (event === "start") {
        phraseRef.current = [...preRollRef.current, frame];
        changePhase("hearing");
        return;
      }
      if (!detectorRef.current.inPhrase && event === null) {
        preRollRef.current.push(frame);
        const keep = Math.ceil(PRE_ROLL_MS / frameMs);
        if (preRollRef.current.length > keep) preRollRef.current.splice(0, preRollRef.current.length - keep);
        return;
      }
      phraseRef.current.push(frame);
      if (event === "end") {
        const length = phraseRef.current.reduce((n, f) => n + f.length, 0);
        const merged = new Float32Array(length);
        let offset = 0;
        for (const f of phraseRef.current) {
          merged.set(f, offset);
          offset += f.length;
        }
        resetCapture();
        changePhase("transcribing");
        void transcribe(resampleTo16k(merged, sampleRate));
      } else if (event === "discard") {
        resetCapture();
        changePhase(inFlightRef.current > 0 ? "transcribing" : idlePhase());
      }
    },
    [changePhase, idlePhase, resetCapture, transcribe],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== "off") return;
    setError(null);
    changePhase("starting");
    try {
      const ready = await ensureDictationModel(setModelProgress);
      setModelProgress(null);
      if (!ready) return changePhase("off");
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
  }, [changePhase, onFrame, release, resumeListening]);

  const toggleMute = useCallback(() => {
    if (phaseRef.current === "off" || phaseRef.current === "starting") return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    resetCapture();
    const current = phaseRef.current;
    if (current === "listening" || current === "hearing" || current === "muted") changePhase(next ? "muted" : "listening");
  }, [changePhase, resetCapture]);

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
  };
}
