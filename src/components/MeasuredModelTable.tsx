import { useMemo, useState } from "react";
import type { MeasuredModelStats, ModelPrice } from "../lib/ipc";
import { estimatedCost } from "./ModelPricesEditor";

const number = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const percent = (n: number, d: number) => d ? `${number(n * 100 / d)} %` : "—";
const seconds = (ms: number | null) => ms === null ? "—" : `${number(ms / 1000)} s`;

export function MeasuredModelTable({ rows, prices, minReliable }: { rows: MeasuredModelStats[]; prices: ModelPrice[]; minReliable: number }) {
  const [sort, setSort] = useState({ key: "turns", desc: true });
  const [subagents, setSubagents] = useState(true);
  const shown = useMemo(() => rows.filter(r => subagents || !r.isSubagent).sort((a, b) => {
    const va = Number(a[sort.key as keyof MeasuredModelStats] ?? -1);
    const vb = Number(b[sort.key as keyof MeasuredModelStats] ?? -1);
    return sort.desc ? vb - va : va - vb;
  }), [rows, sort, subagents]);
  const maxTurns = Math.max(1, ...shown.map(r => r.turns));
  const headings = [
    ["turns", "Tours (n)"], ["medianDurationMs", "Durée médiane"], ["medianFirstTokenMs", "Premier token"],
    ["medianTokensPerSecond", "Tokens/s (tour)"], ["outputTokens", "Sortie / tour"], ["errors", "Erreurs"],
    ["interrupted", "Interruptions"], ["rewrites", "Réécritures"], ["cacheReadTokens", "Cache"], ["toolErrors", "Outils en erreur"],
  ];
  return <section aria-labelledby="measured-models-title">
    <h2 id="measured-models-title">Tours mesurés</h2>
    <label><input type="checkbox" checked={subagents} onChange={e => setSubagents(e.target.checked)} /> Inclure les sous-agents (lignes séparées)</label>
    {!shown.length ? <p className="python-runtime__muted">Aucun tour mesuré pour ce filtre. Les prochains tours seront enregistrés localement.</p> : <div className="model-stats__table-wrap">
      <table className="model-stats__table model-stats__measured">
        <thead><tr><th scope="col">Modèle</th>{headings.map(([key, label]) => <th scope="col" key={key} aria-sort={sort.key === key ? sort.desc ? "descending" : "ascending" : "none"}>
          <button type="button" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : true })}>{label}{sort.key === key ? sort.desc ? " ↓" : " ↑" : ""}</button>
        </th>)}{prices.length > 0 && <th scope="col">Coût estimé</th>}</tr></thead>
        <tbody>{shown.map(r => {
          const price = prices.find(p => p.provider === r.provider && p.model === r.model);
          return <tr key={[r.harness, r.provider, r.model, r.isSubagent].join("|")}>
            <th scope="row"><span className="model-stats__model">{r.model}</span><span className="model-stats__sub">{r.provider} · {r.harness === "rlm" ? "RLM" : "Chat"}{r.isSubagent && " · sous-agent"}{r.turns < minReliable && <span className="model-stats__warn">n faible</span>}</span></th>
            <td>{r.turns}<span className="model-stats__bar" aria-hidden="true"><span style={{ width: `${r.turns * 100 / maxTurns}%` }} /></span></td>
            <td>{seconds(r.medianDurationMs)}</td><td>{seconds(r.medianFirstTokenMs)}</td>
            <td title={`n = ${r.speedSamples} tours réussis avec usage connu ; outils et attentes compris.`}>{r.medianTokensPerSecond == null ? "—" : number(r.medianTokensPerSecond)}<small> n={r.speedSamples}</small></td>
            <td title={`${r.usageTurns} tours avec usage connu`}>{r.usageTurns ? number(r.outputTokens / r.usageTurns) : "—"}</td>
            <td>{percent(r.errors, r.turns)}</td><td>{percent(r.interrupted, r.turns)}</td>
            <td title="Proxy de satisfaction, pas une évaluation de qualité.">{r.isSubagent ? "—" : percent(r.rewrites, r.turns)}</td>
            <td>{percent(r.cacheReadTokens, r.promptTokens)}</td><td>{percent(r.toolErrors, r.toolCalls)}</td>
            {prices.length > 0 && <td title="Uniquement les tokens connus ; devise de votre grille.">{price && r.usageTurns ? number(estimatedCost(r, price)) : "—"}</td>}
          </tr>;
        })}</tbody>
      </table>
    </div>}
    <p className="python-runtime__muted">Période exacte pour ces tours. Le débit est celui du tour entier, outils et attentes compris, pas la vitesse de génération pure. Les réécritures sont un proxy de satisfaction. RLM : durée, premier texte, statut et outils ; tokens inconnus affichés « — ».</p>
  </section>;
}
