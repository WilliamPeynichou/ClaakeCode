export const TARGET_RATE = 16_000;
export const END_SILENCE_MS = 2000;
/** How often the composer shows a fresh partial transcript while the user speaks. */
export const PARTIAL_EVERY_MS = 2000;
export const MIN_PHRASE_MS = 400;
export const MAX_PHRASE_MS = 30_000;
export const PRE_ROLL_MS = 300;

export type VoiceCommand = "stop" | "repeat" | "exit";

/** getUserMedia failures in words the user can act on. */
export function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Micro refusé : autorise l'accès dans Réglages Système › Confidentialité et sécurité › Micro, puis réessaie.";
  }
  if (name === "NotFoundError") return "Aucun micro détecté.";
  if (name === "NotReadableError") return "Le micro est déjà utilisé par une autre app.";
  if (!navigator.mediaDevices?.getUserMedia) return "Le micro n'est pas disponible dans cette fenêtre.";
  return e instanceof Error ? e.message : String(e);
}

export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COMMANDS: Record<string, VoiceCommand> = {
  stop: "stop",
  arrete: "stop",
  repete: "repeat",
  repeat: "repeat",
  "passe a l ecrit": "exit",
  "mode ecrit": "exit",
};

export type VoiceInput = { kind: "command"; command: VoiceCommand } | { kind: "message"; text: string } | { kind: "ignore" };

export function interpretTranscript(text: string): VoiceInput {
  const normalized = normalizeSpeech(text);
  const command = COMMANDS[normalized];
  if (command) return { kind: "command", command };
  const trimmed = text.trim();
  return normalized.split(" ").filter(Boolean).length >= 2 ? { kind: "message", text: trimmed } : { kind: "ignore" };
}

/** Text typed before speaking stays at the start of the message. */
export function joinDraft(...parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(" ");
}

export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Box-filter downsampling to 16 kHz mono. */
export function resampleTo16k(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return samples;
  const ratio = fromRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / (end - start);
  }
  return out;
}

/** "split": the phrase hit MAX_PHRASE_MS; transcribe that chunk and keep listening. */
export type DetectorEvent = "start" | "split" | "end" | "discard" | null;

/** Turns a stream of RMS levels into phrase start/end events. */
export class PhraseDetector {
  private noise = 0.005;
  private speaking = false;
  private silenceMs = 0;
  private voicedMs = 0;
  private totalMs = 0;

  get threshold(): number {
    return Math.max(0.015, this.noise * 2.5);
  }

  get inPhrase(): boolean {
    return this.speaking;
  }

  reset() {
    this.speaking = false;
    this.silenceMs = 0;
    this.voicedMs = 0;
    this.totalMs = 0;
  }

  push(level: number, frameMs: number): DetectorEvent {
    const loud = level > this.threshold;
    if (!this.speaking) {
      if (!loud) {
        this.noise = this.noise * 0.95 + level * 0.05;
        return null;
      }
      this.speaking = true;
      this.silenceMs = 0;
      this.voicedMs = frameMs;
      this.totalMs = frameMs;
      return "start";
    }
    this.totalMs += frameMs;
    if (loud) {
      this.silenceMs = 0;
      this.voicedMs += frameMs;
    } else {
      this.silenceMs += frameMs;
    }
    if (this.silenceMs >= END_SILENCE_MS) {
      const keep = this.voicedMs >= MIN_PHRASE_MS;
      this.reset();
      return keep ? "end" : "discard";
    }
    if (this.totalMs >= MAX_PHRASE_MS) {
      this.totalMs = 0;
      return "split";
    }
    return null;
  }
}

const FRENCH_WORDS = /\b(le|la|les|des|une|un|est|et|j'ai|j ai|fait|fichiers?|dans|pour|avec|que|pas|sont|ont|sur|mais|ça|je)\b/gi;

export function detectLanguage(text: string): "fr" | "en" {
  if (/[àâçéèêëîïôùûœ]/i.test(text)) return "fr";
  return (text.match(FRENCH_WORDS)?.length ?? 0) >= 2 ? "fr" : "en";
}
