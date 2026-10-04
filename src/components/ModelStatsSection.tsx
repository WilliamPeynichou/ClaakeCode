import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, type ModelStatsFilter, type ModelStatsReport, type ModelStatsRow } from "../lib/ipc";

/**
 * Settings « Performance des modèles » (benchmark B3, docs/plansNouvellesFeatures.md).
 * Measures the user's real usage, not model quality: n is always shown and small samples flagged.
 */

const PERIODS: { label: string; days: number | null }[] = [
  { label: "7 jours", days: 7 },
  { label: "30 jours", days: 30 },
  { label: "Tout", days: null },
];

const HARNESSES: { label: string; value: ModelStatsFilter["harness"] }[] = [
  { label: "Tous", value: null },
  { label: "Chat", value: "classic" },
  { label: "RLM", value: "rlm" },
];

type Column = {
  id: string;
  label: string;
  title: string;
  value: (row: ModelStatsRow) => number | null;
  format: (value: number) => string;
  /** Show a mini bar relative to the column max. */
  bar?: boolean;
};

const intFormat = new Intl.NumberFormat("fr-FR");
const compact = (value: number) =>
  value >= 10_000 ? `${(value / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k` : intFormat.format(Math.round(value));
const percent = (value: number) => `${(value * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;
const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

const COLUMNS: Column[] = [
  {
    id: "responses",
    label: "Réponses (n)",
    title: "Réponses du modèle avec usage enregistré. Un tour avec outils compte plusieurs réponses.",
    value: (r) => r.responses,
    format: (v) => intFormat.format(v),
    bar: true,
  },
  {
    id: "conversations",
    label: "Conversations",
    title: "Conversations où le modèle a répondu au moins une fois.",
    value: (r) => r.conversations,
    format: (v) => intFormat.format(v),
  },
  {
    id: "prompt",
    label: "Contexte / réponse",
    title: "Tokens d'entrée moyens par réponse, cache compris.",
    value: (r) => ratio(r.promptTokens, r.responses),
    format: compact,
    bar: true,
  },
  {
    id: "output",
    label: "Sortie / réponse",
    title: "Tokens de sortie moyens par réponse.",
    value: (r) => ratio(r.outputTokens, r.responses),
    format: compact,
    bar: true,
  },
  {
    id: "reasoning",
    label: "Raisonnement",
    title: "Part des tokens de sortie consacrée au raisonnement (si le provider la renvoie).",
    value: (r) => ratio(r.reasoningTokens, r.outputTokens),
    format: percent,
  },
  {
    id: "cache",
    label: "Cache",
    title: "Part du contexte lue depuis le cache du provider.",
    value: (r) => ratio(r.cacheReadTokens, r.promptTokens),
    format: percent,
    bar: true,
  },
  {
    id: "toolErrors",
    label: "Outils en erreur",
    title: "Appels d'outils demandés par ce modèle qui ont échoué.",
    value: (r) => ratio(r.toolErrors, r.toolCalls),
    format: percent,
  },
];

const rowKey = (r: ModelStatsRow) => `${r.harness}|${r.provider}|${r.model}`;

export function ModelStatsSection() {
  const [filter, setFilter] = useState<ModelStatsFilter>({ periodDays: 30, harness: null });
  const [report, setReport] = useState<ModelStatsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<{ id: string; desc: boolean }>({ id: "responses", desc: true });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api.getModelStats(filter));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const column = COLUMNS.find((c) => c.id === sort.id) ?? COLUMNS[0];
    const list = [...(report?.rows ?? [])];
    list.sort((a, b) => {
      const va = column.value(a) ?? -1;
      const vb = column.value(b) ?? -1;
      return sort.desc ? vb - va : va - vb;
    });
    return list;
  }, [report, sort]);

  const maxima = useMemo(() => {
    const out: Record<string, number> = {};
    for (const column of COLUMNS) {
      out[column.id] = Math.max(0, ...rows.map((r) => column.value(r) ?? 0));
    }
    return out;
  }, [rows]);

  const exportCsv = async () => {
    setStatus(null);
    try {
      const dest = await save({
        defaultPath: "performance-modeles.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!dest) return;
      await api.exportModelStatsCsv(filter, dest);
      setStatus("Export CSV enregistré.");
    } catch (err) {
      setError(String(err));
    }
  };

  const minReliable = report?.minReliable ?? 20;
  const toggleSort = (id: string) =>
    setSort((current) => (current.id === id ? { id, desc: !current.desc } : { id, desc: true }));

  return (
    <>
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">Performance des modèles</h1>
          <p className="settings-pane__subtitle">
            Chiffres tirés de votre usage réel, calculés en local. Ce n'est pas un classement de
            qualité : ils dépendent des tâches, des prompts et du réseau.
          </p>
        </div>
        <div className="settings-pane__actions">
          <button type="button" className="settings-pane__btn" onClick={() => void load()} disabled={loading}>
            <Icon icon="solar:refresh-linear" width={13} height={13} />
            <span>Actualiser</span>
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            onClick={() => void exportCsv()}
            disabled={!report || report.rows.length === 0}
          >
            <Icon icon="solar:download-linear" width={13} height={13} />
            <span>Exporter CSV</span>
          </button>
        </div>
      </header>
      <div className="settings-pane__body python-runtime model-stats">
        <div className="model-stats__filters">
          <div className="model-stats__segmented" role="group" aria-label="Période">
            {PERIODS.map((p) => (
              <button
                key={p.label}
                type="button"
                data-active={filter.periodDays === p.days ? "true" : "false"}
                onClick={() => setFilter((f) => ({ ...f, periodDays: p.days }))}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="model-stats__segmented" role="group" aria-label="Harness">
            {HARNESSES.map((h) => (
              <button
                key={h.label}
                type="button"
                data-active={filter.harness === h.value ? "true" : "false"}
                onClick={() => setFilter((f) => ({ ...f, harness: h.value }))}
              >
                {h.label}
              </button>
            ))}
          </div>
          {report && (
            <span className="python-runtime__muted">
              {intFormat.format(report.totalResponses)} réponses au total
            </span>
          )}
        </div>

        {error && <p className="python-runtime__error" role="alert">{error}</p>}
        {status && <p className="python-runtime__muted" role="status">{status}</p>}

        {!report ? (
          <p className="python-runtime__muted">Chargement…</p>
        ) : rows.length === 0 ? (
          <div className="model-stats__empty">
            <strong>Pas encore de données sur cette période</strong>
            <p className="python-runtime__muted">
              Les statistiques apparaissent après quelques échanges avec un modèle dans le chat.
              {filter.harness === "rlm" && " Le chat RLM n'enregistre pas encore l'usage des tokens."}
            </p>
          </div>
        ) : (
          <div className="model-stats__table-wrap">
            <table className="model-stats__table">
              <thead>
                <tr>
                  <th scope="col">Modèle</th>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.id}
                      scope="col"
                      title={c.title}
                      aria-sort={sort.id === c.id ? (sort.desc ? "descending" : "ascending") : "none"}
                    >
                      <button type="button" onClick={() => toggleSort(c.id)}>
                        {c.label}
                        {sort.id === c.id && <span aria-hidden="true">{sort.desc ? " ↓" : " ↑"}</span>}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const lowSample = row.responses < minReliable;
                  return (
                    <tr key={rowKey(row)} data-low={lowSample ? "true" : "false"}>
                      <th scope="row">
                        <span className="model-stats__model">{row.model}</span>
                        <span className="model-stats__sub">
                          {row.provider}
                          <span className="rlm-memory__badge">{row.harness === "rlm" ? "RLM" : "Chat"}</span>
                          {lowSample && (
                            <span
                              className="model-stats__warn"
                              title={`Moins de ${minReliable} réponses : chiffres peu fiables.`}
                            >
                              n faible
                            </span>
                          )}
                        </span>
                      </th>
                      {COLUMNS.map((c) => {
                        const value = c.value(row);
                        const max = maxima[c.id];
                        return (
                          <td key={c.id}>
                            <span>{value === null ? "—" : c.format(value)}</span>
                            {c.bar && value !== null && max > 0 && (
                              <span className="model-stats__bar" aria-hidden="true">
                                <span style={{ width: `${Math.max(2, (value / max) * 100)}%` }} />
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <ul className="model-stats__notes python-runtime__muted">
          <li>
            Sous {minReliable} réponses, une ligne est marquée « n faible » : les écarts peuvent
            venir du hasard.
          </li>
          <li>
            La période retient les conversations actives depuis la date choisie (les messages
            ne sont pas encore horodatés un par un).
          </li>
          <li>
            Pas encore mesurés : durée des tours, vitesse (tokens/s), temps au premier token, taux
            d'erreur des appels au modèle et usage du chat RLM.
          </li>
          <li>Rien n'est envoyé sur le réseau : seuls des compteurs sont lus, jamais le contenu des messages.</li>
        </ul>
      </div>
    </>
  );
}
