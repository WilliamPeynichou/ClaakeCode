import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DiffEditor } from "@monaco-editor/react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/ipc";
import { monacoThemeForDocument } from "../lib/monacoThemes";
import type { GitFileDiff, GitStatusFile } from "../types";

function languageFor(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", rs: "rust", md: "markdown", css: "css", html: "html",
    py: "python", toml: "ini", yml: "yaml", yaml: "yaml", sh: "shell",
  };
  return ext ? map[ext] : undefined;
}

/** Read-only preview of what the next commit will contain for one file. */
export function GitDiffDialog({
  workspacePath,
  file,
  onClose,
}: {
  workspacePath: string;
  file: GitStatusFile;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(() => {
    const request = ++requestRef.current;
    api
      .gitFileDiff(workspacePath, file.path, file.oldPath ?? null)
      .then((next) => {
        if (request !== requestRef.current) return;
        setDiff(next);
        setError(null);
        setStale(false);
      })
      .catch((err) => {
        if (request !== requestRef.current) return;
        setError(String(err));
        setStale(true);
      });
  }, [workspacePath, file.path, file.oldPath]);

  useEffect(() => {
    setDiff(null);
    load();
    let timer: number | undefined;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ workspacePath: string }>("workspace-file-changed", (event) => {
      if (event.payload.workspacePath !== workspacePath) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 300);
    }).then((fn) => (cancelled ? fn() : (unlisten = fn)));
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      requestRef.current++;
      window.clearTimeout(timer);
      unlisten?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [load, onClose, workspacePath]);

  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return createPortal(
    <div className="git-diff__backdrop" onClick={onClose} role="presentation">
      <div
        className="git-diff"
        role="dialog"
        aria-label={`Changes in ${file.path}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="git-diff__head">
          <span className="git-diff__title" title={title}>{title}</span>
          <span className="git-diff__hint">HEAD → next commit</span>
          <button type="button" className="git-panel__head-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        {stale && <div className="git-diff__notice">Could not refresh: this preview may be out of date. {error}</div>}
        <div className="git-diff__body">
          {error && !diff ? (
            <div className="git-diff__message">{error}</div>
          ) : !diff ? (
            <div className="git-diff__message">Loading…</div>
          ) : diff.kind !== "text" ? (
            <div className="git-diff__message">{diff.message ?? "No preview available."}</div>
          ) : (
            <DiffEditor
              original={diff.original ?? ""}
              modified={diff.modified ?? ""}
              language={languageFor(file.path)}
              theme={monacoThemeForDocument()}
              options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, scrollBeyondLastLine: false }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
