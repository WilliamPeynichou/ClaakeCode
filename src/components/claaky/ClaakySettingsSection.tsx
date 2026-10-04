import { useState } from "react";
import { Claaky, type ClaakyState } from "./Claaky";
import { setClaakyEnabled, useClaakyEnabled } from "./useClaakyEnabled";

const STATES: { state: ClaakyState; label: string }[] = [
  { state: "idle", label: "Attend" },
  { state: "thinking", label: "Réfléchit" },
  { state: "working", label: "Code" },
  { state: "planning", label: "Planifie" },
  { state: "done", label: "Terminé" },
  { state: "error", label: "Erreur" },
  { state: "sleeping", label: "Dort" },
];

export function ClaakySettingsSection() {
  const enabled = useClaakyEnabled();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ClaakyState>("idle");

  const toggle = async () => {
    try {
      setError(null);
      await setClaakyEnabled(!enabled);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <>
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">Claaky</h1>
          <p className="settings-pane__subtitle">
            Votre compagnon : vous lui parlez, c'est lui qui code. Il remplace les animations de
            chargement et accueille l'écran vide.
          </p>
        </div>
      </header>
      <div className="settings-pane__body python-runtime">
        {error && <p className="python-runtime__error" role="alert">{error}</p>}
        <label className="claaky-settings__toggle">
          <input type="checkbox" checked={enabled} onChange={() => void toggle()} />
          <span>Afficher Claaky et lui donner la parole</span>
        </label>
        <p className="python-runtime__muted">
          Désactivé : les anciens indicateurs de chargement reviennent et l'agent n'adopte plus le
          nom Claaky. Ses règles, ses outils et sa langue ne changent pas dans les deux cas.
        </p>
        <p className="python-runtime__muted">
          Cliquez sur une pose pour la voir en grand : chaque pose correspond à ce que fait l'agent
          (réfléchit, code, planifie, a terminé, erreur, dort après 90 s sans activité).
        </p>
        <div className="claaky-settings__preview">
          <Claaky state={preview} size={168} />
        </div>
        <div className="claaky-settings__states">
          {STATES.map(({ state, label }) => (
            <button
              key={state}
              type="button"
              className="claaky-settings__state"
              data-active={preview === state ? "true" : "false"}
              onClick={() => setPreview(state)}
              aria-label={`Voir la pose : ${label}`}
            >
              <Claaky state={state} size={56} decorative />
              <span className="python-runtime__muted">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
