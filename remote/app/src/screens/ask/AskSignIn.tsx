import { useState } from "react";
import { PixelScene, type SceneAnchor } from "../../ui/PixelScene";
import "../launch.css";

const ERRORS: Record<string, string> = {
  not_allowed: "Ce compte GitHub n'est pas dans la bêta. Demande l'accès à l'organisateur de la bêta.",
  state: "La connexion a expiré. Recommence.",
  github: "GitHub n'a pas répondu. Recommence.",
  not_configured: "La connexion GitHub n'est pas encore configurée sur le serveur.",
};

function GitHubMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Sign-in for Claake Ask: Claaky's meadow, then "Continue with GitHub". */
export function AskSignIn({ error }: { error: string | null }) {
  const [anchor, setAnchor] = useState<SceneAnchor | null>(null);
  const [leaving, setLeaving] = useState(false);
  return (
    <div className="launch launch--inline" data-leaving={false}>
      <PixelScene leaving={leaving} excited={0} headroom={120} onAnchor={setAnchor}>
        {anchor && (
          <p className="launch__bubble" style={{ "--x": `${anchor.x}px`, "--y": `${anchor.y}px` } as React.CSSProperties}>
            <span className="launch__bubble-body">{error ? "Oups ! Petit souci de connexion." : "Salut ! On fait connaissance ?"}</span>
          </p>
        )}
      </PixelScene>
      <section className="launch__sheet" aria-labelledby="signin-title">
        <p className="launch__eyebrow">Claake · Bêta</p>
        <h1 id="signin-title" className="launch__title">
          <span>Ton assistant,</span> <em>dans la poche.</em>
        </h1>
        <p className="launch__lead">Conversations, projets avec leurs documents, et le mode vocal. Gratuit pendant la bêta.</p>
        {error && <p className="ask-signin__error" role="alert">{ERRORS[error] ?? "La connexion a échoué. Recommence."}</p>}
        <a
          className="ask-github"
          href="/v1/auth/github/start"
          onClick={() => setLeaving(true)}
        >
          <GitHubMark />
          Continuer avec GitHub
        </a>
        <p className="ask-signin__note">Claake lit seulement ton nom et ton avatar GitHub, pas tes dépôts.</p>
      </section>
    </div>
  );
}
