import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, type BenchmarkRun } from "../lib/ipc";

const fmt = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 4 });
type Progress = { runId: string; completed: number; total: number; status: string; estimatedCostUsd: number };

export function ActiveBenchmarkSection() {
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [budget, setBudget] = useState("1");
  const [repetitions, setRepetitions] = useState("1");
  const [maxTokens, setMaxTokens] = useState("512");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const reload = () => api.getActiveBenchmarkRuns().then(setRuns).catch((e) => setError(String(e)));
  useEffect(() => { void reload(); let stop: UnlistenFn | undefined; void listen<Progress>("active-benchmark-progress", (event) => { setProgress(event.payload); void reload(); }).then((unlisten) => { stop = unlisten; }); return () => stop?.(); }, []);
  const selected = providerId && modelId;
  const launch = async () => {
    if (!selected || !confirm) return;
    setBusy(true); setError(null);
    try {
      const runId = await api.startActiveBenchmark({ providerId, modelId, budgetUsd: Number(budget), maxOutputTokens: Number(maxTokens), repetitions: Number(repetitions), confirmed: true });
      setProgress({ runId, completed: 0, total: 3 * Number(repetitions), status: "running", estimatedCostUsd: 0 });
      setConfirm(false); await reload();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <section className="active-benchmark" aria-labelledby="active-benchmark-title">
    <h2 id="active-benchmark-title">Benchmark actif · benchmark-v1</h2>
    <p className="python-runtime__muted">Suite fixe de tâches sans outils. Les appels fournisseurs peuvent être payants. Aucun lancement automatique ; résultats conservés séparément de l’usage réel.</p>
    <div className="active-benchmark__form">
      <label>Provider ID<input value={providerId} onChange={(e) => setProviderId(e.target.value)} placeholder="ex. openai" /></label>
      <label>Model ID<input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="ID exact du catalogue configuré" /></label>
      <label>Budget estimatif USD<input type="number" min="0.000001" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
      <label>Répétitions<input type="number" min="1" max="10" value={repetitions} onChange={(e) => setRepetitions(e.target.value)} /></label>
      <label>Tokens max / cas<input type="number" min="1" max="4096" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} /></label>
    </div>
    <p>Estimation avant lancement : indisponible ici. Le backend exige des tarifs configurés et vérifie une réservation estimative. Ce budget ne garantit pas un plafond de facture : les tarifs et limites appliqués par le fournisseur peuvent différer. Budget estimatif choisi : {fmt(Number(budget) || 0)} USD.</p>
    {error && <p role="alert" className="python-runtime__error">{error}</p>}
    {confirm ? <div><p role="alert">Confirmation explicite : exécuter {Number(repetitions) * 3} requêtes au plus sur {providerId}/{modelId}, avec budget estimatif de {fmt(Number(budget) || 0)} USD (plafond de facture non garanti) ?</p><button type="button" disabled={busy || !selected} onClick={() => void launch()}>Confirmer et lancer</button><button type="button" onClick={() => setConfirm(false)}>Annuler</button></div> : <button type="button" disabled={busy || !selected || Number(budget) <= 0} onClick={() => setConfirm(true)}>Préparer le lancement</button>}
    {progress && <div role="status"><p>Progression : {progress.completed}/{progress.total} · {progress.status} · estimé {fmt(progress.estimatedCostUsd)} USD</p>{progress.status === "running" && <button type="button" onClick={() => void api.stopActiveBenchmark(progress.runId).catch((e) => setError(String(e)))}>Arrêter</button>}</div>}
    <h3>Historique du benchmark</h3>
    {!runs.length ? <p className="python-runtime__muted">Aucun résultat benchmark enregistré.</p> : <div className="model-stats__table-wrap"><table className="model-stats__table"><thead><tr><th>Modèle / suite</th><th>Statut</th><th>Cas terminés</th><th>Tokens</th><th>Coût estimé USD</th><th>TTFT médian</th><th>Débit sortie médian</th><th>Vérifications</th></tr></thead><tbody>{runs.map((r) => <tr key={r.runId}><th>{r.provider}/{r.model}<small>{r.suiteVersion}</small></th><td>{r.status}</td><td>{r.completedCases}/{r.totalCases}</td><td>{fmt(r.inputTokens + r.outputTokens)}</td><td>{fmt(r.estimatedCost)}</td><td>{r.medianTtftMs == null ? "—" : `${fmt(r.medianTtftMs)} ms`}</td><td>{r.medianOutputTokensPerSecond == null ? "—" : fmt(r.medianOutputTokensPerSecond)}</td><td>{r.verifiedChecks}</td></tr>)}</tbody></table></div>}
    <p className="python-runtime__muted">N limité à la suite et aux répétitions indiquées; tâches, paramètres et fournisseur influencent les résultats. Pas de classement d’usage réel ni de qualité générale.</p>
  </section>;
}
