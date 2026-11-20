import { useMemo, useState } from "react";
import type { DiagnosticsSnapshot } from "../lib/diagnostics";
import type { Problem } from "../lib/diagnostics";

const STATUS_TEXT: Record<string, string> = {
  running: "checking…",
  ok: "no problems",
  problems: "problems found",
  toolMissing: "checker not available",
  failed: "check failed",
  timedOut: "check timed out",
  cancelled: "cancelled",
};

export function ProblemsPanel({
  snapshot,
  onEnable,
  onDisable,
  onRerun,
  onOpen,
}: {
  snapshot: DiagnosticsSnapshot | null;
  onEnable: () => void;
  onDisable: () => void;
  onRerun: () => void;
  onOpen: (problem: Problem) => void;
}) {
  const [open, setOpen] = useState(false);
  const counts = useMemo(() => {
    const problems = snapshot?.problems ?? [];
    return {
      errors: problems.filter((p) => p.severity === "error").length,
      warnings: problems.filter((p) => p.severity === "warning").length,
    };
  }, [snapshot]);

  if (!snapshot?.registered) return null;

  const confirmEnable = () => {
    const ok = window.confirm(
      "Run project checks automatically after files change?\n\n" +
        "This runs `tsc --noEmit` (local TypeScript) and `cargo check` in this workspace. " +
        "They execute project code such as build scripts and procedural macros. " +
        "Permission is kept until this workspace is closed.",
    );
    if (ok) onEnable();
  };

  return (
    <div className="problems" data-open={open ? "true" : "false"}>
      <div className="problems__bar">
        <button type="button" className="problems__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          Problems
          {snapshot.enabled && (
            <span className="problems__counts">
              {counts.errors} errors · {counts.warnings} warnings{snapshot.running ? " · checking…" : ""}
            </span>
          )}
        </button>
        {snapshot.enabled ? (
          <span className="problems__actions">
            <button type="button" className="problems__link" onClick={onRerun}>Re-run</button>
            <button type="button" className="problems__link" onClick={onDisable}>Turn off</button>
          </span>
        ) : (
          <button type="button" className="problems__link" onClick={confirmEnable}>Turn on automatic checks</button>
        )}
      </div>
      {open && snapshot.enabled && (
        <div className="problems__list">
          {snapshot.projects.map((project) => (
            <div key={project.root} className="problems__project" data-status={project.status}>
              {project.root} · {project.tool}: {STATUS_TEXT[project.status] ?? project.status}
              {project.message ? <pre>{project.message}</pre> : null}
            </div>
          ))}
          {snapshot.problems.map((problem, index) => (
            <button
              type="button"
              key={`${problem.path}:${problem.line}:${problem.column}:${index}`}
              className="problems__item"
              data-severity={problem.severity}
              onClick={() => onOpen(problem)}
            >
              <span className="problems__where">{problem.path}:{problem.line}:{problem.column}</span>
              <span className="problems__msg">{problem.message}</span>
              {problem.code ? <span className="problems__code">{problem.code}</span> : null}
            </button>
          ))}
          {snapshot.problems.length === 0 && snapshot.projects.length === 0 && (
            <div className="problems__project">No TypeScript or Rust project found.</div>
          )}
        </div>
      )}
    </div>
  );
}
