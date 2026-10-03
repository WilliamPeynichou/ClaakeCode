import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { api, type PythonRuntimeStatus, type RlmMemoryEntry } from "../lib/ipc";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

const KIND_LABEL: Record<RlmMemoryEntry["kind"], string> = {
  memory: "Mémoire",
  skill: "Skill",
  prompt: "Prompt",
  subagent: "Sous-agent",
};

/**
 * What the RLM agent has learned and saved (Prime's persisted harness): readable, editable and
 * deletable here. Variables Python are volatile; these entries survive restarts and new chats.
 */
function RlmMemoryList() {
  const [entries, setEntries] = useState<RlmMemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", content: "" });
  const [confirming, setConfirming] = useState<string | null>(null);
  const keyOf = (e: RlmMemoryEntry) => `${e.scope}|${e.kind}|${e.id}`;

  const load = useCallback(async () => {
    try {
      setEntries(await api.listRlmMemories());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const scopes = Array.from(new Map((entries ?? []).map((e) => [e.scope, e.scopeLabel])).entries());
  const shown = (entries ?? []).filter((e) => scope === "all" || e.scope === scope);

  const save = async (e: RlmMemoryEntry) => {
    try {
      await api.editRlmMemory({ scope: e.scope, kind: e.kind, id: e.id, ...draft });
      setEditing(null);
      await load();
    } catch (err) {
      setError(String(err));
    }
  };
  const remove = async (e: RlmMemoryEntry) => {
    try {
      await api.deleteRlmMemory({ scope: e.scope, kind: e.kind, id: e.id });
      setConfirming(null);
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <section className="python-runtime__packages rlm-memory" aria-labelledby="rlm-memory-title">
      <div className="python-runtime__packages-head">
        <h2 id="rlm-memory-title">Mémoire de l'agent ({shown.length})</h2>
        <div className="rlm-memory__tools">
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Portée">
            <option value="all">Toutes les portées</option>
            {scopes.map(([id, label]) => (
              <option key={id} value={id}>
                {id === "global" ? "Globale" : `Chat : ${label}`}
              </option>
            ))}
          </select>
          <button type="button" className="settings-pane__btn" onClick={() => void load()}>
            <Icon icon="solar:refresh-linear" width={13} height={13} />
            <span>Recharger</span>
          </button>
        </div>
      </div>
      <p className="python-runtime__muted">
        Ce que l'agent a retenu et sauvegardé : il le relit dans les chats suivants. Les variables
        Python, elles, disparaissent au redémarrage du noyau. Rien ici n'entraîne le modèle. « Apprendre
        de ce chat » (onglet RLM) demande une consolidation tout de suite ; sinon Prime consolide selon
        ses propres règles.
      </p>
      {error && <p className="python-runtime__error" role="alert">{error}</p>}
      {entries && shown.length === 0 && (
        <p className="python-runtime__muted">Rien de sauvegardé pour l'instant.</p>
      )}
      <ul className="rlm-memory__list">
        {shown.map((e) => {
          const key = keyOf(e);
          const isEditing = editing === key;
          return (
            <li key={key} className="rlm-memory__item">
              <div className="rlm-memory__meta">
                <span className="rlm-memory__badge">{KIND_LABEL[e.kind]}</span>
                <span className="rlm-memory__badge" data-scope={e.scope === "global" ? "global" : "chat"}>
                  {e.scope === "global" ? "Globale" : `Chat : ${e.scopeLabel}`}
                </span>
                <span className="python-runtime__muted">
                  {e.source === "user" ? "modifiée par vous" : e.source || "agent"} ·{" "}
                  {e.updatedAt ? new Date(e.updatedAt).toLocaleString() : "—"} · v{e.version}
                </span>
              </div>
              {isEditing ? (
                <div className="rlm-memory__edit">
                  <input
                    value={draft.title}
                    onChange={(ev) => setDraft({ ...draft, title: ev.target.value })}
                    aria-label="Titre"
                  />
                  <textarea
                    rows={5}
                    value={draft.content}
                    onChange={(ev) => setDraft({ ...draft, content: ev.target.value })}
                    aria-label="Contenu"
                  />
                  <div className="rlm-memory__row">
                    <button type="button" className="settings-pane__btn" onClick={() => void save(e)}>
                      Enregistrer
                    </button>
                    <button type="button" className="settings-pane__btn" onClick={() => setEditing(null)}>
                      Annuler
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <strong className="rlm-memory__title">{e.title}</strong>
                  <p className="rlm-memory__content">{e.content}</p>
                  <div className="rlm-memory__row">
                    <button
                      type="button"
                      className="settings-pane__btn"
                      onClick={() => {
                        setEditing(key);
                        setDraft({ title: e.title, content: e.content });
                      }}
                    >
                      Modifier
                    </button>
                    {confirming === key ? (
                      <>
                        <button type="button" className="settings-pane__btn" onClick={() => void remove(e)}>
                          Confirmer la suppression
                        </button>
                        <button type="button" className="settings-pane__btn" onClick={() => setConfirming(null)}>
                          Annuler
                        </button>
                      </>
                    ) : (
                      <button type="button" className="settings-pane__btn" onClick={() => setConfirming(key)}>
                        Supprimer
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
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
            <RlmMemoryList />
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
