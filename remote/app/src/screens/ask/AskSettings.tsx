import { useEffect, useState } from "react";
import { askApi, type AskUser, type ProviderAccount } from "../../ask/api";
import { SUBSCRIPTIONS, connectedAccounts, refreshAccounts, type Subscription } from "../../ask/models";
import { clearKey, connect, getKey, setKey } from "../../ask/openrouter";
import { Spinner } from "../../ui/common";
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

      <Subscriptions open={open} onError={onError} />

      <section className="group">
        <h2 className="group__title">OpenRouter</h2>
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
                  void refreshAccounts();
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
                  void refreshAccounts();
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

type Pending = { provider: Subscription; loginId?: string; url?: string; userCode?: string };

/** Claude, ChatGPT, Gemini, Kimi and Mistral: signed in once from here, kept encrypted by the server. */
function Subscriptions({ open, onError }: { open: boolean; onError(err: unknown): void }) {
  const [accounts, setAccounts] = useState<ProviderAccount[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) void connectedAccounts().then(setAccounts);
    else setPending(null);
  }, [open]);

  async function done() {
    setPending(null);
    setInput("");
    setAccounts(await refreshAccounts());
  }

  async function begin(provider: Subscription) {
    setInput("");
    const signIn = SUBSCRIPTIONS.find((s) => s.id === provider)!.signIn;
    setPending({ provider });
    if (signIn === "key") return;
    try {
      const started = await askApi.startProviderLogin(provider);
      setPending((p) => (p?.provider === provider ? { provider, ...started } : p));
    } catch (err) {
      setPending(null);
      onError(err);
    }
  }

  async function finish() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      if (pending.provider === "mistral") await askApi.saveProviderKey("mistral", input);
      else await askApi.finishProviderLogin(pending.provider, pending.loginId!, input);
      await done();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  // Kimi confirms on its own page: ask the server every few seconds until it is done.
  useEffect(() => {
    if (pending?.provider !== "kimi" || !pending.loginId) return;
    const timer = window.setInterval(() => {
      askApi
        .finishProviderLogin("kimi", pending.loginId!)
        .then((r) => (r.connected ? done() : undefined))
        .catch((err) => {
          setPending(null);
          onError(err);
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending?.provider, pending?.loginId]);

  return (
    <section className="group ask-subscriptions">
      <h2 className="group__title">Abonnements</h2>
      <div className="group__body">
        {SUBSCRIPTIONS.map((s) => {
          const account = accounts?.find((a) => a.provider === s.id);
          const active = pending?.provider === s.id;
          return (
            <div key={s.id} className="ask-sub" data-open={active}>
              <div className="row row--compact row--static">
                <span className="ask-sub__logo" data-provider={s.id}>{s.label[0]}</span>
                <span className="row__text">
                  <strong>{s.label}</strong>
                  <span>{account ? account.label ?? "Connecté" : s.plan}</span>
                </span>
                {accounts === null ? (
                  <Spinner size={16} />
                ) : account ? (
                  <button
                    type="button"
                    className="ask-sub__action ask-sub__action--quiet"
                    onClick={() => void askApi.disconnectProvider(s.id).then(done).catch(onError)}
                  >
                    Retirer
                  </button>
                ) : (
                  <button type="button" className="ask-sub__action" onClick={() => (active ? setPending(null) : void begin(s.id))}>
                    {active ? "Annuler" : "Connecter"}
                  </button>
                )}
              </div>
              {active && (
                <div className="ask-sub__panel">
                  {s.signIn === "key" ? (
                    <p>
                      Crée une clé sur{" "}
                      <a href="https://console.mistral.ai/api-keys" target="_blank" rel="noreferrer">console.mistral.ai</a>, puis colle-la ici.
                    </p>
                  ) : !pending.url ? (
                    <Spinner size={18} />
                  ) : s.signIn === "device" ? (
                    <>
                      <p>Ouvre Kimi et confirme ce code. Cette page se met à jour toute seule.</p>
                      <strong className="ask-sub__code">{pending.userCode}</strong>
                      <a className="button button--primary button--wide" href={pending.url} target="_blank" rel="noreferrer">Ouvrir Kimi</a>
                    </>
                  ) : (
                    <>
                      <a className="button button--primary button--wide" href={pending.url} target="_blank" rel="noreferrer">
                        1. Se connecter à {s.label}
                      </a>
                      <p>
                        {s.id === "anthropic"
                          ? "2. Copie le code affiché à la fin, puis colle-le ici."
                          : "2. À la fin, la page ne s'ouvre pas (adresse localhost) : c'est normal. Copie son adresse et colle-la ici."}
                      </p>
                    </>
                  )}
                  {s.signIn !== "device" && (pending.url || s.signIn === "key") && (
                    <form
                      className="ask-openrouter__paste"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void finish();
                      }}
                    >
                      <input
                        className="ask-input"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={s.signIn === "key" ? "Clé API Mistral" : s.id === "anthropic" ? "Code Claude" : "http://localhost…"}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                      />
                      <button type="submit" className="button" disabled={!input.trim() || busy}>
                        {busy ? <Spinner size={14} /> : "OK"}
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="group__footer">
        Connecte tes abonnements une fois : le serveur de Claake garde tes accès chiffrés et les utilise pour toi, même quand ton Mac est éteint.
        Ces abonnements sont prévus pour les apps de chaque service, qui peuvent limiter cet usage.
      </p>
    </section>
  );
}
