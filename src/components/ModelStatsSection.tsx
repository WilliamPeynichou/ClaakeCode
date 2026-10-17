import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { save } from "@tauri-apps/plugin-dialog";
import { modelStatsCalendarRange, shiftModelStatsCalendar } from "../lib/modelStatsPeriod";
import { ModelPricesEditor } from "./ModelPricesEditor";
import { MeasuredModelTable } from "./MeasuredModelTable";
import { UsageTimeline } from "./UsageTimeline";
import { ActiveBenchmarkSection } from "./ActiveBenchmarkSection";
import { api, type ModelStatsFilter, type ModelStatsReport, type ModelStatsRow } from "../lib/ipc";

/**
 * Settings « Performance des modèles » (benchmark B3, docs/plansNouvellesFeatures.md).
 * Measures the user's real usage, not model quality: n is always shown and small samples flagged.
 */

const PERIODS: { label: string; value: "7" | "30" | "month" | "year" | "all" }[] = [
  { label: "7 jours", value: "7" },
  { label: "30 jours", value: "30" },
  { label: "Mois", value: "month" },
  { label: "Année", value: "year" },
  { label: "Tout", value: "all" },
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
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["value"]>("30");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [year, setYear] = useState(() => String(new Date().getFullYear()));
  const [harness, setHarness] = useState<ModelStatsFilter["harness"]>(null);
  const calendar = period === "month" || period === "year" ? period : null;
  const calendarValue = calendar === "month" ? month : year;
  const range = useMemo(() => calendar ? modelStatsCalendarRange(calendar, calendarValue) : null, [calendar, calendarValue]);
  const validPeriod = !calendar || !!range;
  const filter = useMemo<ModelStatsFilter>(() => ({
    periodDays: period === "7" ? 7 : period === "30" ? 30 : null,
    harness,
    ...range,
  }), [period, harness, range]);
  const [loaded, setLoaded] = useState<{ filter: ModelStatsFilter; report: ModelStatsReport } | null>(null);
  // Never render the previous period under the newly selected label, even before the effect runs.
  const report = validPeriod && loaded && JSON.stringify(loaded.filter) === JSON.stringify(filter) ? loaded.report : null;
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<{ id: string; desc: boolean }>({ id: "responses", desc: true });

  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [requestId] = useState(() => ({ current: 0 }));
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoaded(null);
    setError(null);
    setStatus(null);
    if (!validPeriod) { setLoading(false); return; }
    setLoading(true);
    try {
      const next = await api.getModelStats(filter);
      if (id !== requestId.current) return;
      setLoaded({ filter, report: next });
      setError(null);
    } catch (err) {
      if (id === requestId.current) setError(String(err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [filter, requestId, validPeriod]);

  useEffect(() => {
    void load();
    return () => { ++requestId.current; };
  }, [load, requestId]);

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
          <h1>Performance des modèles</h1>
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
            disabled={loading || (!report?.rows.length && !report?.measured?.length)}
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
                data-active={period === p.value ? "true" : "false"}
                aria-pressed={period === p.value}
                onClick={() => setPeriod(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {calendar && <div className="model-stats__calendar">
            <button type="button" className="settings-pane__btn" aria-label={calendar === "month" ? "Mois précédent" : "Année précédente"}
              disabled={!shiftModelStatsCalendar(calendar, calendarValue, -1)}
              onClick={() => { const next = shiftModelStatsCalendar(calendar, calendarValue, -1); if (next) (calendar === "month" ? setMonth : setYear)(next); }}>←</button>
            <label>
              <span>{calendar === "month" ? "Mois calendaire" : "Année calendaire"}</span>
              <input type={calendar === "month" ? "month" : "number"} min={calendar === "month" ? "0001-01" : 1}
                max={calendar === "month" ? "9998-12" : 9998} step={1} value={calendarValue}
                onChange={(event) => (calendar === "month" ? setMonth : setYear)(event.target.value)} />
            </label>
            <button type="button" className="settings-pane__btn" aria-label={calendar === "month" ? "Mois suivant" : "Année suivante"}
              disabled={!shiftModelStatsCalendar(calendar, calendarValue, 1)}
              onClick={() => { const next = shiftModelStatsCalendar(calendar, calendarValue, 1); if (next) (calendar === "month" ? setMonth : setYear)(next); }}>→</button>
          </div>}
          <div className="model-stats__segmented" role="group" aria-label="Harness">
            {HARNESSES.map((h) => (
              <button
                key={h.label}
                type="button"
                data-active={filter.harness === h.value ? "true" : "false"}
                aria-pressed={filter.harness === h.value}
                onClick={() => setHarness(h.value)}
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

        <p className="python-runtime__muted" aria-live="polite">
          {range ? <>Du {new Date(range.startAtMs).toLocaleString("fr-FR")} inclus au {new Date(range.endAtMs).toLocaleString("fr-FR")} exclu</>
            : calendar ? "Sélectionnez une période valide (année de 0001 à 9998)."
            : period === "all" ? "Tout l’historique" : `${period} derniers jours glissants`}
          {" · Fuseau local : "}{Intl.DateTimeFormat().resolvedOptions().timeZone}
        </p>
        {loading && <p className="python-runtime__muted" role="status">Chargement des statistiques…</p>}
        {error && <p className="python-runtime__error" role="alert">{error}</p>}
        {status && <p className="python-runtime__muted" role="status">{status}</p>}

        {report && !report.rows.length && <p className="python-runtime__muted">Pas encore de données historiques pour ce filtre.</p>}
        {report && <>
          {calendar && <UsageTimeline period={calendar} value={calendarValue} harness={harness} />}
          <MeasuredModelTable rows={report.measured ?? []} prices={report.prices ?? []} minReliable={minReliable} />
          <details><summary>Tarifs et coûts estimés</summary><ModelPricesEditor key={JSON.stringify(report.prices ?? [])} initial={report.prices ?? []} onSaved={() => { void load(); window.dispatchEvent(new Event("claakecode:model-stats-changed")); }} /></details>
          <div className="settings-pane__actions">
            {confirmClear ? <>
              <button type="button" className="settings-pane__btn" disabled={clearing} onClick={async () => {
                setClearing(true);
                try { await api.clearModelStats(); setConfirmClear(false); await load(); window.dispatchEvent(new Event("claakecode:model-stats-changed")); }
                catch (e) { setError(String(e)); } finally { setClearing(false); }
              }}>Confirmer l’effacement</button>
              <button type="button" className="settings-pane__btn" onClick={() => setConfirmClear(false)}>Annuler</button>
            </> : <button type="button" className="settings-pane__btn" onClick={() => setConfirmClear(true)}>Effacer les statistiques</button>}
          </div>
          <p className="python-runtime__muted">Effacement de toutes les statistiques, tous filtres confondus, sans supprimer vos chats ni vos tarifs. Les compteurs historiques restent masqués ; les prochains tours sont mesurés.</p>
        </>}
        <ActiveBenchmarkSection />
        <h2>Historique des réponses (rétroactif)</h2>
        {!report ? null : rows.length === 0 ? (
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
            Période exacte pour les nouveaux tours, selon leur heure de démarrage. Historique approximatif : la période filtre la dernière activité des conversations, pas la date de chaque réponse ; leurs anciens messages peuvent donc être inclus.
          </li>
          <li>
            Ce tableau historique ne mesure pas les durées. Les mesures précises des nouveaux tours sont affichées au-dessus, sans les additionner à cet historique.
          </li>
          <li>Aucun compteur n’est envoyé sur le réseau. La table de mesures ne stocke ni prompts ni réponses ; l’agrégation rétroactive lit l’historique existant en local.</li>
        </ul>
      </div>
    </>
  );
}
