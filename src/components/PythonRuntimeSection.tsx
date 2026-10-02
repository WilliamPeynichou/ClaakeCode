import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { api, type PythonRuntimeStatus } from "../lib/ipc";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/**
 * Settings view of the persistent Python environment. A single engine backs it: Prime's kernel,
 * used by the RLM chat (and later by Auto Compute). Read-only except restart.
 */
export function PythonRuntimeSection() {
  const [status, setStatus] = useState<PythonRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getPythonRuntimeStatus());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const restart = async () => {
    setBusy(true);
    try {
      await api.restartPythonRuntime();
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const env = status?.env;
  const packages = (env?.packages ?? []).filter((p) =>
    p.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <>
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">Python persistant</h1>
          <p className="settings-pane__subtitle">
            Environnement Python du moteur Prime : les variables et l'état survivent d'un message à
            l'autre dans chaque conversation RLM.
          </p>
        </div>
        <div className="settings-pane__actions">
          <button
            type="button"
            className="settings-pane__btn"
            onClick={() => void refresh()}
            disabled={busy}
          >
            <Icon icon="solar:refresh-linear" width={13} height={13} />
            <span>Actualiser</span>
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            onClick={() => void restart()}
            disabled={busy || !status?.running}
            title="Arrête le moteur et tous les noyaux Python. Les conversations reprennent au prochain message, mais les variables en mémoire sont perdues."
          >
            <Icon icon="solar:restart-linear" width={13} height={13} />
            <span>Redémarrer</span>
          </button>
        </div>
      </header>
      <div className="settings-pane__body python-runtime">
        {error && <p className="python-runtime__error" role="alert">{error}</p>}
        {!status ? (
          <p className="python-runtime__muted">Chargement…</p>
        ) : (
          <>
            <dl className="python-runtime__grid">
              <dt>Moteur</dt>
              <dd>
                <span className="python-runtime__dot" data-on={status.running ? "true" : "false"} />
                {status.running ? "En marche" : "Arrêté (démarre au premier message RLM)"}
              </dd>
              <dt>Sessions actives</dt>
              <dd>{status.activeSessions}</dd>
              <dt>Python</dt>
              <dd>{env?.installed ? env.pythonVersion ?? "inconnu" : "Pas encore installé"}</dd>
              <dt>Taille</dt>
              <dd>{env?.installed ? formatBytes(env.sizeBytes) : "—"}</dd>
              <dt>Emplacement</dt>
              <dd>
                <code>{env?.venvPath}</code>
              </dd>
              <dt>Providers</dt>
              <dd>{status.connectedProviders.length ? status.connectedProviders.join(", ") : "—"}</dd>
            </dl>
            <p className="python-runtime__muted">
              Exécution locale avec vos droits, sans sandbox. Chaque conversation RLM travaille dans
              son propre worktree.
            </p>
            <div className="python-runtime__packages">
              <div className="python-runtime__packages-head">
                <h2>Packages ({env?.packages.length ?? 0})</h2>
                <input
                  type="search"
                  placeholder="Filtrer…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label="Filtrer les packages"
                />
              </div>
              {env?.installed ? (
                <ul>
                  {packages.map((p) => (
                    <li key={p.name}>
                      <span>{p.name}</span>
                      <span className="python-runtime__muted">{p.version}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="python-runtime__muted">
                  L'environnement est créé au premier usage de Python par l'agent RLM.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
