import { useState } from "react";
import { Claaky } from "./Claaky";
import { ClaakyScene } from "./ClaakyScene";

/** Editor empty state: Claaky asks what we do next, with two quick starts. */
export function ClaakyEmpty() {
  const [fallback, setFallback] = useState(false);
  const act = (action: "new-chat" | "new-rlm-chat") =>
    window.dispatchEvent(new CustomEvent("claakecode:claaky-action", { detail: action }));

  return (
    <div className="editor-empty claaky-empty">
      {fallback ? (
        <Claaky state="idle" size={120} />
      ) : (
        <ClaakyScene size={168} onUnavailable={() => setFallback(true)} />
      )}
      <span className="editor-empty__title">Que faisons-nous ?</span>
      <span className="editor-empty__sub">
        Dites-le moi dans le chat, ou ouvrez un fichier dans la barre latérale.
      </span>
      <div className="claaky-empty__actions">
        <button type="button" className="claaky-empty__btn" onClick={() => act("new-chat")}>
          Discuter avec Claaky
        </button>
        <button type="button" className="claaky-empty__btn" onClick={() => act("new-rlm-chat")}>
          Calculer avec Claaky (RLM)
        </button>
      </div>
    </div>
  );
}
