import { ClaakeCodeMark } from "../ClaakeCodeMark";

/** Editor empty state: the Claake Code mark (Claaky lives in the chat), with two quick starts. */
export function ClaakyEmpty() {
  const act = (action: "new-chat" | "new-rlm-chat") =>
    window.dispatchEvent(new CustomEvent("claakecode:claaky-action", { detail: action }));

  return (
    <div className="editor-empty claaky-empty">
      <span className="brand-tile" aria-hidden="true">
        <ClaakeCodeMark size={56} decorative />
      </span>
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
