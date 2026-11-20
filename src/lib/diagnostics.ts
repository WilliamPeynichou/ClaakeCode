import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Problem = {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning";
  code?: string | null;
  message: string;
  source: string;
};

export type DiagnosticsProject = {
  root: string;
  tool: string;
  status: "running" | "ok" | "problems" | "toolMissing" | "failed" | "timedOut" | "cancelled";
  message?: string | null;
};

export type DiagnosticsSnapshot = {
  workspacePath: string;
  registered: boolean;
  enabled: boolean;
  running: boolean;
  projects: DiagnosticsProject[];
  problems: Problem[];
};

const input = (workspacePath: string, enabled?: boolean) => ({ input: { workspacePath, enabled } });

export function useDiagnostics(workspacePath: string) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    setSnapshot(null);
    // The watcher registers the workspace asynchronously; retry once it exists.
    const load = () =>
      invoke<DiagnosticsSnapshot>("diagnostics_snapshot", input(workspacePath))
        .then((next) => !cancelled && setSnapshot((prev) => prev ?? next))
        .catch(() => undefined);
    void load();
    const retry = window.setTimeout(load, 1500);
    void listen<DiagnosticsSnapshot>("workspace-diagnostics-updated", (event) => {
      if (event.payload.workspacePath === workspacePath) setSnapshot(event.payload);
    }).then((fn) => (cancelled ? fn() : (unlisten = fn)));
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      unlisten?.();
    };
  }, [workspacePath]);

  const setEnabled = useCallback(
    (enabled: boolean) =>
      invoke<DiagnosticsSnapshot>("diagnostics_set_enabled", input(workspacePath, enabled)).then(setSnapshot),
    [workspacePath],
  );
  const rerun = useCallback(
    () => invoke<DiagnosticsSnapshot>("diagnostics_rerun", input(workspacePath)).then(setSnapshot),
    [workspacePath],
  );
  return { snapshot, setEnabled, rerun };
}
