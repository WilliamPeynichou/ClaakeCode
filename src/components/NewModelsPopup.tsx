import { useEffect, useRef, useState } from "react";
import { MODEL_ANNOUNCEMENTS_KEY, PROVIDERS, useModelCatalogVersion } from "../lib/models";
import { parseModelAnnouncements, type ModelAnnouncementState } from "../lib/modelAnnouncements";
import "./NewModelsPopup.css";

function read(): ModelAnnouncementState | null {
  try {
    return parseModelAnnouncements(localStorage.getItem(MODEL_ANNOUNCEMENTS_KEY));
  } catch {
    return null;
  }
}

export function NewModelsPopup() {
  const version = useModelCatalogVersion();
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState(read);

  useEffect(() => {
    const refresh = () => setState(read());
    refresh();
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [version]);

  const pending = state?.pending ?? [];
  useEffect(() => {
    const element = dialog.current;
    if (pending.length && element && !element.open) element.showModal();
    if (!pending.length && element?.open) element.close();
  }, [pending.length]);

  function dismiss() {
    // Read latest storage so acknowledging this popup cannot drop newer pending entries.
    const latest = read();
    const shown = new Set(pending.map((model) => model.value));
    if (latest) {
      const next = { ...latest, pending: latest.pending.filter((model) => !shown.has(model.value)) };
      try {
        localStorage.setItem(MODEL_ANNOUNCEMENTS_KEY, JSON.stringify(next));
        window.dispatchEvent(new Event("storage"));
      } catch { /* Dismiss still works when browser storage is unavailable. */ }
      setState(next);
    } else setState(null);
  }

  return (
    <dialog ref={dialog} className="new-models" aria-labelledby="new-models-title" aria-describedby="new-models-description"
      onCancel={(event) => { event.preventDefault(); dismiss(); }}>
      <div className="new-models__layout">
        <header>
          <span className="new-models__eyebrow">Catalogue Claake Code</span>
          <h2 id="new-models-title">De nouveaux<br /><em>possibles.</em></h2>
          <p id="new-models-description">{pending.length === 1 ? "Un nouveau modèle est disponible" : `${pending.length} nouveaux modèles sont disponibles`} dans votre sélecteur, selon les providers connectés. Aucune mise à jour à installer.</p>
        </header>
        <ul aria-label="Nouveaux modèles">
          {pending.map((model) => (
            <li key={model.value}>
              <span>{PROVIDERS.find((provider) => provider.value === model.provider)?.label ?? model.provider}</span>
              <strong>{model.label}</strong>
            </li>
          ))}
        </ul>
      </div>
      <footer><button type="button" autoFocus onClick={dismiss}>C’est noté</button></footer>
    </dialog>
  );
}
