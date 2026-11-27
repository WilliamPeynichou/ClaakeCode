import { useEffect, useState } from "react";
import type { AskUser } from "../../ask/api";
import { clearKey, connect, getKey, setKey } from "../../ask/openrouter";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { Avatar } from "./AskHome";

export function AskSettings({ open, user, onClose, onSignOut, onError }: {
  open: boolean;
  user: AskUser;
  onClose(): void;
  onSignOut(): void;
  onError(err: unknown): void;
}) {
  const [connected, setConnected] = useState(() => Boolean(getKey()));
  const [pasted, setPasted] = useState("");
  useEffect(() => {
    if (open) setConnected(Boolean(getKey()));
  }, [open]);

  return (
    <Sheet open={open} title="Réglages" onClose={onClose}>
      <section className="group">
        <div className="group__body">
          <div className="row row--static ask-account">
            <Avatar user={user} size={44} />
            <span className="row__text">
              <strong>{user.name || user.login}</strong>
              <span>@{user.login} · GitHub</span>
            </span>
          </div>
        </div>
      </section>

      <section className="group">
        <h2 className="group__title">Modèles</h2>
        <div className="group__body">
          {connected ? (
            <>
              <div className="row row--static">
                <span className="row__icon" data-tone="ok"><Icon name="check" size={18} stroke={2.4} /></span>
                <span className="row__text">
                  <strong>OpenRouter connecté</strong>
                  <span>Ta clé reste sur ce téléphone.</span>
                </span>
              </div>
              <button
                type="button"
                className="row row--danger row--compact"
                onClick={() => {
                  clearKey();
                  setConnected(false);
                }}
              >
                <span className="row__text"><strong>Déconnecter OpenRouter</strong></span>
              </button>
            </>
          ) : (
            <div className="ask-openrouter">
              <button type="button" className="button button--primary button--wide" onClick={() => void connect().catch(onError)}>
                Se connecter avec OpenRouter
              </button>
              <form
                className="ask-openrouter__paste"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!pasted.trim().startsWith("sk-or-")) return onError(new Error("Une clé OpenRouter commence par sk-or-."));
                  setKey(pasted);
                  setPasted("");
                  setConnected(true);
                }}
              >
                <input
                  className="ask-input"
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder="ou colle une clé sk-or-…"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <button type="submit" className="button" disabled={!pasted.trim()}>OK</button>
              </form>
            </div>
          )}
        </div>
        <p className="group__footer">
          Chaque testeur utilise son propre compte OpenRouter. Les modèles gratuits ne coûtent rien ; ta clé n'est jamais envoyée au serveur de Claake.
        </p>
      </section>

      <section className="group">
        <div className="group__body">
          <button type="button" className="row row--danger row--compact" onClick={onSignOut}>
            <span className="row__text"><strong>Se déconnecter</strong></span>
          </button>
        </div>
      </section>
    </Sheet>
  );
}
