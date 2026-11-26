import { Icon } from "../ui/Icon";

function ShareGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V3M8 7l4-4 4 4M7 10H5v11h14V10h-2" />
    </svg>
  );
}

/** Shown in Safari: notifications and a clean full-screen app need the Home Screen version. */
export function InstallScreen({ code, onSkip }: { code: string | null; onSkip(): void }) {
  return (
    <main className="onboard">
      <img className="onboard__logo" src="/icons/icon-192.png" alt="" width={84} height={84} />
      <h1>Claake Code sur ton iPhone</h1>
      <p className="onboard__lead">Installe l'app pour piloter ton agent et recevoir ses notifications.</p>
      <ol className="steps">
        <li>
          <span className="steps__n">1</span>
          <span>
            Touche <span className="steps__glyph"><ShareGlyph /></span> <strong>Partager</strong> en bas de Safari.
          </span>
        </li>
        <li>
          <span className="steps__n">2</span>
          <span>
            Choisis <span className="steps__glyph"><Icon name="plus" size={16} /></span> <strong>Sur l'écran d'accueil</strong>, puis Ajouter.
          </span>
        </li>
        <li>
          <span className="steps__n">3</span>
          <span>Ouvre <strong>Claake</strong> depuis l'écran d'accueil et entre le code de ton Mac.</span>
        </li>
      </ol>
      {code && (
        <div className="onboard__code">
          <span>Ton code</span>
          <strong>{code.slice(0, 3)} {code.slice(3)}</strong>
          <small>Valable quelques minutes : garde l'appairage ouvert sur le Mac.</small>
        </div>
      )}
      <button type="button" className="link-button" onClick={onSkip}>
        Continuer dans Safari
      </button>
    </main>
  );
}
