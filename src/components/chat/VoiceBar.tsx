import { Icon } from "@iconify/react";
import type { VoicePhase } from "../../lib/useVoiceMode";
import { splitSpoken } from "../../lib/spoken";
import { Markdown } from "./Markdown";

const PHASE_LABEL: Record<VoicePhase, string> = {
  off: "",
  starting: "Préparation du micro…",
  listening: "À l'écoute",
  muted: "Micro coupé",
  hearing: "Je vous entends…",
  transcribing: "Transcription…",
  speaking: "Lecture de la synthèse",
};

export type VoiceBarState = {
  phase: VoicePhase;
  muted: boolean;
  level: number;
  error: string | null;
  modelProgress: number | null;
  canSpeak: boolean;
  toggleMute: () => void;
  stopSpeaking: () => void;
  exit: () => void;
};

export function VoiceBar({ voice }: { voice: VoiceBarState }) {
  const { phase, muted, level, error, modelProgress } = voice;
  const label =
    modelProgress !== null
      ? `Téléchargement du modèle vocal… ${Math.round(modelProgress * 100)} %`
      : PHASE_LABEL[phase];
  return (
    <div className="voice-bar" data-phase={phase} role="status">
      <span
        className="voice-bar__dot"
        style={{ "--voice-level": Math.min(1, Math.max(0, level)) } as React.CSSProperties}
        aria-hidden="true"
      />
      <span className="voice-bar__label">{error ?? label}</span>
      {modelProgress !== null && (
        <span className="voice-bar__progress" aria-hidden="true">
          <span style={{ width: `${Math.round(modelProgress * 100)}%` }} />
        </span>
      )}
      <span className="voice-bar__spacer" />
      {phase === "speaking" && (
        <button
          type="button"
          className="voice-bar__btn"
          onClick={voice.stopSpeaking}
          title="Arrêter la lecture (Échap)"
          aria-label="Arrêter la lecture"
        >
          <Icon icon="solar:stop-circle-bold" width={15} height={15} />
        </button>
      )}
      <button
        type="button"
        className="voice-bar__btn"
        data-active={muted ? "true" : undefined}
        onClick={voice.toggleMute}
        title={muted ? "Rallumer le micro (⌘⇧M)" : "Couper le micro (⌘⇧M)"}
        aria-label={muted ? "Rallumer le micro" : "Couper le micro"}
        aria-pressed={muted}
      >
        <Icon
          icon={muted ? "solar:microphone-3-bold" : "solar:microphone-3-linear"}
          width={15}
          height={15}
        />
        {muted && <span className="voice-bar__slash" aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="voice-bar__btn"
        onClick={voice.exit}
        title="Quitter le mode vocal"
        aria-label="Quitter le mode vocal"
      >
        <Icon icon="solar:close-circle-linear" width={15} height={15} />
      </button>
    </div>
  );
}

export function SpokenCard({
  text,
  pending,
  onReplay,
}: {
  text: string;
  pending?: boolean;
  onReplay?: () => void;
}) {
  return (
    <aside className="spoken-card" data-pending={pending ? "true" : undefined}>
      <div className="spoken-card__head">
        <Icon icon="solar:soundwave-linear" width={14} height={14} />
        <span>Synthèse</span>
        {onReplay && !pending && (
          <button
            type="button"
            className="spoken-card__replay"
            onClick={onReplay}
            title="Rejouer la synthèse"
            aria-label="Rejouer la synthèse"
          >
            <Icon icon="solar:play-circle-linear" width={15} height={15} />
          </button>
        )}
      </div>
      <p>{text}</p>
    </aside>
  );
}

/** Réponse assistant en Markdown ; le bloc <spoken> devient une carte « Synthèse ». */
export function AssistantMarkdown({
  text,
  onOpenFile,
  onReplay,
}: {
  text: string;
  onOpenFile: (path: string) => void;
  onReplay?: () => void;
}) {
  const { body, spoken, pending } = splitSpoken(text);
  return (
    <>
      {body.trim() && <Markdown text={body} onOpenFile={onOpenFile} />}
      {spoken !== null && <SpokenCard text={spoken} pending={pending} onReplay={onReplay} />}
    </>
  );
}
