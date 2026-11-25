import { createContext, useContext } from "react";
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
  level: number;
  error: string | null;
  modelProgress: number | null;
  canSpeak: boolean;
  needsChoice: boolean;
  chooseEngine: (choice: "settings" | "apple-server" | "whisper") => void;
  stopSpeaking: () => void;
  exit: () => void;
};

export function VoiceBar({ voice }: { voice: VoiceBarState }) {
  const { phase, level, error, modelProgress } = voice;
  if (phase === "off") {
    return (
      <div className="voice-bar" data-phase="off" role="alert">
        <span className="voice-bar__label">{error}</span>
        <span className="voice-bar__spacer" />
        <button type="button" className="voice-bar__btn" onClick={voice.exit} title="Fermer" aria-label="Fermer">
          <Icon icon="solar:close-circle-linear" width={15} height={15} />
        </button>
      </div>
    );
  }
  const label =
    modelProgress !== null
      ? `Téléchargement du modèle vocal… ${Math.round(modelProgress * 100)} %`
      : PHASE_LABEL[phase];
  return (
    <>
      {voice.needsChoice && (
        <div className="voice-choice" role="alert">
          <p>
            La Dictée de macOS est désactivée : la reconnaissance vocale locale ne peut pas démarrer.
          </p>
          <div className="voice-choice__actions">
            <button type="button" className="voice-choice__btn" data-primary="true" onClick={() => voice.chooseEngine("settings")}>
              Activer la Dictée
            </button>
            <button type="button" className="voice-choice__btn" onClick={() => voice.chooseEngine("apple-server")}>
              Utiliser les serveurs Apple
            </button>
            <button type="button" className="voice-choice__btn" onClick={() => voice.chooseEngine("whisper")}>
              Garder Whisper (plus lent)
            </button>
          </div>
          <small>Avec les serveurs Apple, votre voix est envoyée à Apple pour être transcrite.</small>
        </div>
      )}
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
          onClick={voice.exit}
          title="Quitter le mode vocal"
          aria-label="Quitter le mode vocal"
        >
          <Icon icon="solar:close-circle-linear" width={15} height={15} />
        </button>
      </div>
    </>
  );
}

/**
 * The composer's mic: off → turns voice mode on; on → mutes/unmutes the mic (Discord-style),
 * its halo following the voice level. Leaving voice mode is the ✕ in the voice bar.
 */
export function VoiceMicButton({
  voice,
}: {
  voice: { active: boolean; phase: VoicePhase; muted: boolean; level: number; start: () => Promise<void>; toggleMute: () => void };
}) {
  const { active, phase, muted } = voice;
  const label = !active ? "Activer le mode vocal" : muted ? "Rallumer le micro (⌘⇧M)" : "Couper le micro (⌘⇧M)";
  return (
    <button
      type="button"
      className="composer__iconbtn composer__voice"
      data-active={active ? "true" : undefined}
      data-phase={active ? phase : undefined}
      data-muted={active && muted ? "true" : undefined}
      style={{ "--voice-level": active && !muted ? Math.min(1, Math.max(0, voice.level)) : 0 } as React.CSSProperties}
      onClick={() => (active ? voice.toggleMute() : void voice.start())}
      title={label}
      aria-label={label}
      aria-pressed={active ? !muted : false}
    >
      <Icon icon={active && !muted ? "solar:microphone-3-bold" : "solar:microphone-3-linear"} width={16} height={16} />
      {active && muted && <span className="voice-bar__slash" aria-hidden="true" />}
    </button>
  );
}

/** Mutes the agent's voice (Discord-style headphones), shown next to the voice-mode button. */
export function DeafenButton({ deafened, onToggle }: { deafened: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="composer__iconbtn composer__deafen"
      data-active={deafened ? "true" : undefined}
      onClick={onToggle}
      title={deafened ? "Remettre la voix de l'agent (⌘⇧D)" : "Couper la voix de l'agent (⌘⇧D)"}
      aria-label={deafened ? "Remettre la voix de l'agent" : "Couper la voix de l'agent"}
      aria-pressed={deafened}
    >
      <Icon
        icon={deafened ? "solar:headphones-round-bold" : "solar:headphones-round-linear"}
        width={16}
        height={16}
      />
      {deafened && <span className="voice-bar__slash" aria-hidden="true" />}
    </button>
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

/** Set while voice mode is active: report cards get a ▶ button that reads them aloud. */
export const VoiceReadContext = createContext<((text: string) => void) | null>(null);

/** Réponse assistant en Markdown ; le bloc <spoken> devient une carte « Synthèse ». */
export function AssistantMarkdown({ text, onOpenFile }: { text: string; onOpenFile: (path: string) => void }) {
  const { body, spoken, pending } = splitSpoken(text);
  const read = useContext(VoiceReadContext);
  return (
    <>
      {body.trim() && <Markdown text={body} onOpenFile={onOpenFile} />}
      {spoken !== null && (
        <SpokenCard text={spoken} pending={pending} onReplay={read ? () => read(spoken) : undefined} />
      )}
    </>
  );
}
