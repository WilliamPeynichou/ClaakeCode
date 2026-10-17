import { useEffect, useMemo, useState } from "react";
import { api, type ModelStatsFilter, type ModelUsageBucket } from "../lib/ipc";
import { modelStatsCalendarRange } from "../lib/modelStatsPeriod";

type Props = { period: "month" | "year"; value: string; harness: ModelStatsFilter["harness"] };
const number = new Intl.NumberFormat("fr-FR");
const cost = (n: number | null) => n == null ? "Inconnu" : `${n.toLocaleString("fr-FR", { maximumFractionDigits: 4 })}`;

function makeBuckets(period: Props["period"], value: string) {
  const whole = modelStatsCalendarRange(period, value);
  if (!whole) return [];
  const result: { startAtMs: number; endAtMs: number }[] = [];
  let cursor = new Date(whole.startAtMs);
  while (cursor.getTime() < whole.endAtMs && result.length < 366) {
    const startAtMs = cursor.getTime();
    const next = new Date(cursor);
    if (period === "month") next.setDate(next.getDate() + 1);
    else next.setMonth(next.getMonth() + 1);
    const endAtMs = Math.min(next.getTime(), whole.endAtMs);
    result.push({ startAtMs, endAtMs });
    cursor = next;
  }
  return result;
}

export function UsageTimeline({ period, value, harness }: Props) {
  const buckets = useMemo(() => makeBuckets(period, value), [period, value]);
  const [data, setData] = useState<ModelUsageBucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null); setError(null);
    if (!buckets.length) return;
    setLoading(true);
    api.getModelUsageSeries({ buckets, harness })
      .then((rows) => { if (active) setData(rows); })
      .catch((e) => { if (active) setError(String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [buckets, harness]);
  const totals = useMemo(() => data ? data.reduce((a, b) => ({
    turns: a.turns + b.turns, inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens, promptTokens: a.promptTokens + b.promptTokens,
    unknownUsageTurns: a.unknownUsageTurns + b.unknownUsageTurns,
    cost: a.cost == null || b.estimatedCost == null ? null : a.cost + b.estimatedCost,
  }), { turns: 0, inputTokens: 0, outputTokens: 0, promptTokens: 0, unknownUsageTurns: 0, cost: 0 as number | null }) : null, [data]);
  const max = Math.max(1, ...(data ?? []).map((b) => b.outputTokens));
  const bucketLabel = (b: ModelUsageBucket) => new Date(b.startAtMs).toLocaleDateString("fr-FR", period === "year" ? { month: "short" } : { day: "numeric" });
  return <section className="usage-timeline" aria-labelledby="usage-timeline-title">
    <h2 id="usage-timeline-title">Usage mesuré par {period === "month" ? "jour" : "mois"}</h2>
    <p className="python-runtime__muted">Tours horodatés exactement · fuseau {Intl.DateTimeFormat().resolvedOptions().timeZone}. Les mesures historiques approximatives ne sont pas incluses.</p>
    {loading && <p role="status" className="python-runtime__muted">Chargement de la série…</p>}
    {error && <p role="alert" className="python-runtime__error">{error}</p>}
    {data && totals && <>
      <div className="usage-timeline__totals" aria-label="Totaux de la période">
        <span><strong>{number.format(totals.turns)}</strong> tours</span>
        <span><strong>{number.format(totals.inputTokens)}</strong> tokens entrée</span>
        <span><strong>{number.format(totals.outputTokens)}</strong> tokens sortie</span>
        <span><strong>{totals.cost == null ? "—" : cost(totals.cost)}</strong> coût estimé†</span>
      </div>
      {!data.some((b) => b.turns > 0) ? <p className="python-runtime__muted">Aucune mesure exacte sur cette période.</p> : <div className="usage-timeline__chart" role="list" aria-label="Tokens de sortie par période">
        {data.map((b) => <div key={b.startAtMs} className="usage-timeline__item" role="listitem" title={`${bucketLabel(b)} · ${number.format(b.turns)} tours · entrée ${number.format(b.inputTokens)} · sortie ${number.format(b.outputTokens)} · coût estimé ${cost(b.estimatedCost)}${b.unknownUsageTurns ? ` · ${b.unknownUsageTurns} tours sans tokens connus` : ""}`}>
          <span className="usage-timeline__bar"><span style={{ height: `${Math.max(2, b.outputTokens / max * 100)}%` }} /></span>
          <small>{bucketLabel(b)}</small>
        </div>)}
      </div>}
      {totals.unknownUsageTurns > 0 && <p className="python-runtime__muted">Tokens inconnus pour {number.format(totals.unknownUsageTurns)} tour(s) ; le coût global est indiqué inconnu si la couverture est incomplète.</p>}
      <p className="python-runtime__muted">† Estimation selon les tarifs actuels configurés, pas une facture. Entrée totale inclut le cache. Export CSV reprend le filtre général; la série reste séparée de l’historique approximatif.</p>
    </>}
  </section>;
}
