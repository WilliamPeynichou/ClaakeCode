import { useEffect, useRef, useState } from "react";
import type { Remote } from "../state";

export function PairScreen({ remote, initialCode }: { remote: Remote; initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(remote.revoked ? "Ce Mac a retiré l'accès de cet iPhone. Appaire-le de nouveau." : null);
  const input = useRef<HTMLInputElement>(null);
  const online = remote.connection.relay === "online";

  useEffect(() => {
    if (!initialCode) input.current?.focus();
  }, [initialCode]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (code.length !== 6 || pending) return;
    setPending(true);
    setError(null);
    try {
      await remote.actions.pair(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCode("");
      input.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="onboard">
      <img className="onboard__logo" src="/icons/icon-192.png" alt="" width={84} height={84} />
      <h1>Connecte ton Mac</h1>
      <p className="onboard__lead">
        Sur ton Mac, ouvre Claake Code, touche <strong>Remote</strong> puis <strong>Open pairing</strong>. Entre le code à 6 chiffres.
      </p>
      <form className="otp" onSubmit={submit}>
        <label className="otp__boxes" onClick={() => input.current?.focus()}>
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="otp__box" data-filled={i < code.length ? "true" : "false"} data-caret={i === code.length ? "true" : "false"}>
              {code[i] ?? ""}
            </span>
          ))}
          <input
            ref={input}
            className="otp__input"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            aria-label="Code d'appairage"
          />
        </label>
        <button type="submit" className="button button--primary button--wide" disabled={code.length !== 6 || pending || !online}>
          {pending ? "Connexion…" : "Connecter"}
        </button>
      </form>
      {error && <p className="onboard__error" role="alert">{error}</p>}
      {!online && <p className="onboard__note">Connexion au relais…</p>}
      <p className="onboard__note">Chiffré de bout en bout entre cet iPhone et ton Mac. Le relais ne voit jamais tes messages.</p>
    </main>
  );
}
