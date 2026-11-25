import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";

export type DictationState = "idle" | "downloading" | "recording" | "transcribing";

const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 120;

export async function toMono16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const length = Math.ceil(decoded.duration * SAMPLE_RATE);
    const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice(0, MAX_SECONDS * SAMPLE_RATE);
  } finally {
    void ctx.close();
  }
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

export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const release = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    release();
  }, [release]);

  const start = useCallback(async () => {
    const ready = await ensureDictationModel((p) => {
      setState("downloading");
      setProgress(p);
    });
    if (!ready) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      release();
      recorderRef.current = null;
      setState("transcribing");
      void toMono16k(new Blob(chunks, { type: recorder.mimeType }))
        .then((samples) => (samples.length ? api.transcribeAudio(samples) : { text: "" }))
        .then(({ text }) => {
          const trimmed = text.trim();
          if (trimmed) onTextRef.current(trimmed);
        })
        .catch((e) => setError(String(e)))
        .finally(() => setState("idle"));
    };
    recorderRef.current = recorder;
    recorder.start();
    timerRef.current = window.setTimeout(() => recorder.stop(), MAX_SECONDS * 1000);
    setState("recording");
  }, [release]);

  const toggle = useCallback(async () => {
    setError(null);
    if (state === "recording") {
      recorderRef.current?.stop();
      return;
    }
    if (state !== "idle") return;
    try {
      await start();
    } catch (e) {
      release();
      setError(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  }, [state, start, release]);

  return { state, progress, error, toggle };
}
