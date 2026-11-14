import { useCallback, useEffect, useState } from "react";
import { api, type Lesson } from "../lib/ipc";

const STATUS_LABEL: Record<Lesson["status"], string> = {
  candidate: "À vérifier",
  validated: "Validée",
  rejected: "Rejetée",
};
const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)} %`);

/**
 * Lot E1: what Claake has learned (table `lessons`). Only validated lessons are recalled in
 * every chat; a candidate is recalled in its own conversation only. Lot D5: "Valider" runs the
 * agent bench without then with the lesson.
 */
export function LessonsSection() {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [status, setStatus] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", content: "", evidence: "" });
  const [adding, setAdding] = useState(false);
  const [validating, setValidating] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [provider, setProvider] = useState(() => localStorage.getItem("claake.bench.provider") ?? "anthropic");
  const [model, setModel] = useState(() => localStorage.getItem("claake.bench.model") ?? "");

  const load = useCallback(async () => {
    try {
      setLessons(await api.listLessons());
    } catch (err) {
      setError(String(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(String(err));
    }
    await load();
  };
  const validate = async (lesson: Lesson) => {
    localStorage.setItem("claake.bench.provider", provider);
    localStorage.setItem("claake.bench.model", model);
    setValidating(lesson.id);
    await act(() => api.validateLesson(lesson.id, provider.trim(), model.trim()));
    setValidating(null);
  };

  const shown = (lessons ?? []).filter((lesson) => status === "all" || lesson.status === status);
  return (
    <section className="python-runtime__packages rlm-memory" aria-labelledby="lessons-title">
      <div className="python-runtime__packages-head">
        <h2 id="lessons-title">Leçons apprises ({shown.length})</h2>
        <div className="rlm-memory__tools">
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut">
            <option value="all">Tous les statuts</option>
            <option value="candidate">À vérifier</option>
            <option value="validated">Validées</option>
            <option value="rejected">Rejetées</option>
          </select>
          <button type="button" className="settings-pane__btn" onClick={() => void load()}>
            Recharger
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            onClick={() => {
              setDraft({ title: "", content: "", evidence: "" });
              setAdding(!adding);
            }}
          >
            Ajouter
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            title="Ajoute les leçons de base (tirées des skills ponytail et caveman, et des erreurs rencontrées sur ce projet). Elles arrivent « à vérifier »."
            onClick={() => void act(() => api.importSeedLessons())}
          >
            Leçons de base
          </button>
          {confirmClear ? (
            <button
              type="button"
              className="settings-pane__btn"
              onClick={() => {
                setConfirmClear(false);
                void act(() => api.clearLessons());
              }}
            >
              Confirmer : tout effacer
            </button>
          ) : (
            <button type="button" className="settings-pane__btn" onClick={() => setConfirmClear(true)}>
              Tout effacer
            </button>
          )}
        </div>
      </div>
      <p className="python-runtime__muted">
        Une leçon validée est rappelée dans tous les chats. Une leçon à vérifier n'est rappelée que dans
        la conversation où elle est née. « Valider » lance le banc de tâches 3 fois sans la leçon puis 3
        fois avec : cela consomme du quota du modèle choisi et n'est disponible que dans la version de
        développement.
      </p>
      <div className="rlm-memory__tools">
        <input value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Fournisseur du banc" placeholder="fournisseur (ex. anthropic)" />
        <input value={model} onChange={(e) => setModel(e.target.value)} aria-label="Modèle du banc" placeholder="modèle du banc" />
        {validating && (
          <button type="button" className="settings-pane__btn" onClick={() => void api.stopBenchRun().catch(() => {})}>
            Arrêter le banc
          </button>
        )}
      </div>
      {error && <p className="python-runtime__error" role="alert">{error}</p>}
      {adding && (
        <div className="rlm-memory__edit">
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Titre" placeholder="Titre" />
          <textarea rows={3} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} aria-label="Contenu" placeholder="Leçon" />
          <textarea rows={2} value={draft.evidence} onChange={(e) => setDraft({ ...draft, evidence: e.target.value })} aria-label="Preuve" placeholder="Preuve (obligatoire) : commande, test ou source qui le montre" />
          <button
            type="button"
            className="settings-pane__btn"
            onClick={() => {
              setAdding(false);
              void act(() => api.addLesson(draft.title, draft.content, draft.evidence));
            }}
          >
            Enregistrer
          </button>
        </div>
      )}
      {lessons && shown.length === 0 && <p className="python-runtime__muted">Aucune leçon pour l'instant.</p>}
      <ul className="rlm-memory__list">
        {shown.map((lesson) => (
          <li key={lesson.id} className="rlm-memory__item">
            <div className="rlm-memory__meta">
              <span className="rlm-memory__badge">{STATUS_LABEL[lesson.status]}</span>
              <span className="python-runtime__muted">
                {lesson.sourceKind} · {new Date(lesson.updatedAtMs).toLocaleString()}
                {lesson.benchRuns > 0 &&
                  ` · sans ${percent(lesson.scoreWithout)} → avec ${percent(lesson.scoreWith)} (${lesson.benchRuns} essais par série)`}
              </span>
            </div>
            {editing === lesson.id ? (
              <div className="rlm-memory__edit">
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Titre" />
                <textarea rows={4} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} aria-label="Contenu" />
                <button
                  type="button"
                  className="settings-pane__btn"
                  onClick={() => {
                    setEditing(null);
                    void act(() => api.updateLesson(lesson.id, draft.title, draft.content));
                  }}
                >
                  Enregistrer (repasse « à vérifier »)
                </button>
                <button type="button" className="settings-pane__btn" onClick={() => setEditing(null)}>
                  Annuler
                </button>
              </div>
            ) : (
              <>
                <strong>{lesson.title}</strong>
                <p>{lesson.content}</p>
                <details>
                  <summary className="python-runtime__muted">Preuve</summary>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{lesson.evidence}</pre>
                </details>
                <div className="rlm-memory__tools">
                  <button
                    type="button"
                    className="settings-pane__btn"
                    onClick={() => {
                      setDraft({ title: lesson.title, content: lesson.content, evidence: "" });
                      setEditing(lesson.id);
                    }}
                  >
                    Modifier
                  </button>
                  <button
                    type="button"
                    className="settings-pane__btn"
                    disabled={validating !== null || !model.trim() || !provider.trim()}
                    title={model.trim() ? "Lance le banc sans puis avec cette leçon" : "Indique d'abord le modèle du banc"}
                    onClick={() => void validate(lesson)}
                  >
                    {validating === lesson.id ? "Banc en cours…" : "Valider"}
                  </button>
                  <button type="button" className="settings-pane__btn" onClick={() => void act(() => api.deleteLesson(lesson.id))}>
                    Supprimer
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
