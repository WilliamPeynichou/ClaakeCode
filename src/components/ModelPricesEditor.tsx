import { useState } from "react";
import { api, type ModelPrice, type MeasuredModelStats } from "../lib/ipc";

export function estimatedCost(row: MeasuredModelStats, price: ModelPrice): number {
  const uncached = Math.max(0, row.promptTokens - row.cacheReadTokens - row.cacheCreationTokens);
  return (uncached * price.input + row.outputTokens * price.output + row.cacheReadTokens * price.cacheRead + row.cacheCreationTokens * price.cacheCreation) / 1_000_000;
}

export function ModelPricesEditor({ initial, onSaved }: { initial: ModelPrice[]; onSaved: () => void }) {
  const [prices, setPrices] = useState<ModelPrice[]>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fields = ["input", "output", "cacheRead", "cacheCreation"] as const;
  const labels = ["Entrée hors cache", "Sortie", "Lecture cache", "Création cache"];
  return <section className="model-stats__prices">
    <h2>Tarifs configurables</h2>
    <p className="python-runtime__muted">Prix par million de tokens, dans une même devise de votre choix. Aucun tarif automatique. Les coûts affichés sont des estimations, hors abonnement et remises.</p>
    {prices.map((p, i) => <fieldset key={i}>
      <legend>Tarif {i + 1}</legend>
      <label>Provider<input value={p.provider} onChange={e => setPrices(prices.map((r, j) => i === j ? { ...r, provider: e.target.value } : r))} /></label>
      <label>Modèle<input value={p.model} onChange={e => setPrices(prices.map((r, j) => i === j ? { ...r, model: e.target.value } : r))} /></label>
      {fields.map((field, k) => <label key={field}>{labels[k]}<input type="number" min="0" step="any" value={p[field]} onChange={e => setPrices(prices.map((r, j) => i === j ? { ...r, [field]: e.target.value === "" ? NaN : Number(e.target.value) } : r))} /></label>)}
      <button className="settings-pane__btn" type="button" onClick={() => setPrices(prices.filter((_, j) => j !== i))}>Retirer le tarif</button>
    </fieldset>)}
    {error && <p role="alert" className="python-runtime__error">{error}</p>}
    <div className="settings-pane__actions">
      <button className="settings-pane__btn" type="button" onClick={() => setPrices([...prices, { provider: "", model: "", input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }])}>Ajouter un tarif</button>
      <button className="settings-pane__btn" type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          if (prices.some(p => !p.provider.trim() || !p.model.trim() || fields.some(f => !Number.isFinite(p[f]) || p[f] < 0))) throw new Error("Provider, modèle et prix positifs ou nuls requis.");
          await api.saveModelPrices(prices.map(p => ({ ...p, provider: p.provider.trim(), model: p.model.trim() })));
          onSaved();
        } catch (e) { setError(String(e)); } finally { setBusy(false); }
      }}>Enregistrer les tarifs</button>
    </div>
  </section>;
}
