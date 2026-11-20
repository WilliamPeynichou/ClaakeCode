import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type HookEvent = "beforeCommit" | "filesChanged" | "turnFinished";
type Hook = {
  id: string;
  name: string;
  event: HookEvent;
  program: string;
  args: string[];
  enabled: boolean;
  timeoutSecs: number;
};
type HookRun = {
  id: string;
  hookName: string;
  event: HookEvent;
  status: "running" | "succeeded" | "failed" | "timedOut" | "cancelled";
  durationMs: number;
  exitCode?: number | null;
  error?: string | null;
  output: string;
};

const EVENT_LABEL: Record<HookEvent, string> = {
  beforeCommit: "Before a commit from the Git panel (blocks on failure)",
  filesChanged: "After files change on disk",
  turnFinished: "After the agent finishes a turn",
};

const commandLine = (hook: Hook) => [hook.program, ...hook.args].join(" ");

/** Local commands run by the IDE itself on an event. Nothing here is read from the repository. */
export function IdeHooksSection({ workspacePath }: { workspacePath: string }) {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [runs, setRuns] = useState<HookRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Hook[]>([]);
  const input = { workspacePath };

  const loadRuns = useCallback(
    () => invoke<HookRun[]>("ide_hooks_runs", { input }).then((r) => setRuns([...r].reverse())).catch(() => undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspacePath],
  );

  useEffect(() => {
    invoke<Hook[]>("ide_hooks_list", { input })
      .then((list) => {
        setHooks(list);
        setSaved(list);
      })
      .catch((err) => setError(String(err)));
    void loadRuns();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("ide-hooks-run-changed", () => void loadRuns()).then((fn) => (cancelled ? fn() : (unlisten = fn)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, loadRuns]);

  const update = (id: string, patch: Partial<Hook>) =>
    setHooks((list) => list.map((hook) => (hook.id === id ? { ...hook, ...patch } : hook)));

  const add = () =>
    setHooks((list) => [
      ...list,
      { id: `hook-${Date.now()}`, name: "New hook", event: "filesChanged", program: "", args: [], enabled: false, timeoutSecs: 60 },
    ]);

  const save = async () => {
    const newlyEnabled = hooks.filter((hook) => {
      const before = saved.find((s) => s.id === hook.id);
      return hook.enabled && (!before?.enabled || commandLine(before) !== commandLine(hook));
    });
    if (newlyEnabled.length > 0) {
      const lines = newlyEnabled.map((hook) => `• ${hook.name}: ${commandLine(hook)}`).join("\n");
      if (!window.confirm(`These commands will run on this computer with your permissions:\n\n${lines}\n\nEnable them?`)) return;
    }
    try {
      const next = await invoke<Hook[]>("ide_hooks_save", { input: { workspacePath, hooks } });
      setHooks(next);
      setSaved(next);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const dirty = JSON.stringify(hooks) !== JSON.stringify(saved);

  return (
    <>
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">IDE hooks</h1>
          <p className="settings-pane__subtitle">
            Commands the IDE runs for you on an event, for this workspace only. They run with your permissions in the
            project folder. No model decides to run them.
          </p>
        </div>
        <div className="settings-pane__actions">
          <button type="button" className="settings-pane__btn" onClick={add}>Add hook</button>
          <button type="button" className="settings-pane__btn" onClick={() => void save()} disabled={!dirty}>Save</button>
        </div>
      </header>
      <div className="settings-pane__body">
        {error && <p role="alert">{error}</p>}
        {hooks.length === 0 && <p>No hooks yet.</p>}
        {hooks.map((hook, index) => (
          <fieldset key={hook.id} className="ide-hook">
            <div className="ide-hook__row">
              <input value={hook.name} onChange={(e) => update(hook.id, { name: e.target.value })} aria-label="Name" />
              <select value={hook.event} onChange={(e) => update(hook.id, { event: e.target.value as HookEvent })} aria-label="Event">
                {(Object.keys(EVENT_LABEL) as HookEvent[]).map((event) => (
                  <option key={event} value={event}>{EVENT_LABEL[event]}</option>
                ))}
              </select>
            </div>
            <div className="ide-hook__row">
              <input value={hook.program} placeholder="Command, e.g. npx" onChange={(e) => update(hook.id, { program: e.target.value })} aria-label="Command" />
              <input
                type="number"
                min={1}
                max={600}
                value={hook.timeoutSecs}
                onChange={(e) => update(hook.id, { timeoutSecs: Number(e.target.value) })}
                aria-label="Timeout in seconds"
                title="Timeout (seconds)"
              />
            </div>
            <textarea
              rows={Math.max(2, hook.args.length)}
              value={hook.args.join("\n")}
              placeholder="One argument per line"
              onChange={(e) => update(hook.id, { args: e.target.value === "" ? [] : e.target.value.split("\n") })}
              aria-label="Arguments"
            />
            <div className="ide-hook__row">
              <label>
                <input type="checkbox" checked={hook.enabled} onChange={(e) => update(hook.id, { enabled: e.target.checked })} /> Enabled
              </label>
              <button type="button" className="settings-pane__btn" disabled={index === 0} onClick={() => setHooks((l) => { const c = [...l]; [c[index - 1], c[index]] = [c[index], c[index - 1]]; return c; })}>Up</button>
              <button type="button" className="settings-pane__btn" onClick={() => setHooks((l) => l.filter((h) => h.id !== hook.id))}>Remove</button>
            </div>
          </fieldset>
        ))}
        <h2>Recent runs</h2>
        {runs.length === 0 && <p>No runs yet.</p>}
        {runs.map((run) => (
          <details key={run.id} className="ide-hook__run" data-status={run.status}>
            <summary>
              {run.hookName} · {run.status}
              {run.exitCode != null ? ` (exit ${run.exitCode})` : ""} · {run.durationMs} ms
              {run.status === "running" && (
                <button type="button" className="settings-pane__btn" onClick={(e) => { e.preventDefault(); void invoke("ide_hooks_cancel", { input: { workspacePath, runId: run.id } }); }}>Cancel</button>
              )}
            </summary>
            {run.error && <p role="alert">{run.error}</p>}
            <pre>{run.output || "(no output)"}</pre>
          </details>
        ))}
      </div>
    </>
  );
}
