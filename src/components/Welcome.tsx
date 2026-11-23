import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "@iconify/react";
import { loadRecents } from "../lib/recents";
import { api } from "../lib/ipc";
import type {
  ActiveTurnSummary,
  ActiveTurnsChangedPayload,
  RecentWorkspace,
} from "../types";
import { WindowControls, isWindowsPlatform } from "./WindowControls";
import { BlobAvatar, shortRelativeTime } from "./BlobAvatar";
import { Claaky } from "./claaky/Claaky";
import { useTheme } from "../lib/theme";

type Props = {
  onPick: (path: string) => void;
  error: string | null;
  deriveName: (path: string) => string;
};

const MAX_VISIBLE_RECENTS = 5;
const IS_WINDOWS = isWindowsPlatform();

/// Collapse a list of `ActiveTurnSummary` items down to the set of workspace
/// paths that currently have an in-flight agent turn. The backend reports
/// these globally (across every Claake Code window), so a recent workspace can be
/// "live" even when it's owned by a sibling window.
function activeWorkspaceSet(turns: ActiveTurnSummary[]): Set<string> {
  return new Set(turns.map((turn) => turn.workspaceId));
}

export function Welcome({ onPick, error, deriveName }: Props) {
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [picking, setPicking] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const [activeWorkspaces, setActiveWorkspaces] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  // Surface running agent turns on the recents list. We seed from
  // `list_active_turns` (so the loader is correct the moment Welcome paints)
  // then keep in sync with the `active-turns-changed` event the backend
  // fans out whenever a turn starts or finishes anywhere in the app.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    void api
      .listActiveTurns()
      .then((turns) => {
        if (!cancelled) setActiveWorkspaces(activeWorkspaceSet(turns));
      })
      .catch(() => {
        // Non-fatal: leave the set empty so the regular folder icon shows.
      });

    (async () => {
      const u = await listen<ActiveTurnsChangedPayload>(
        "active-turns-changed",
        (event) => {
          setActiveWorkspaces(activeWorkspaceSet(event.payload.activeTurns));
        },
      );
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const pickFolder = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        onPick(selected);
      }
    } catch {
      // user cancelled or platform error
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="welcome">
      {IS_WINDOWS && (
        /* Drag region + custom window controls for the frameless Windows
           shell. The wrapper itself is the drag handle (it owns
           `data-tauri-drag-region`); buttons inside opt out via
           `data-tauri-drag-region="false"` set by <WindowControls />. */
        <div
          className="welcome__titlebar"
          data-tauri-drag-region
        >
          <WindowControls />
        </div>
      )}
      <div className="welcome__float" data-windows={IS_WINDOWS ? "true" : undefined}>
        <button
          type="button"
          className="welcome__float-btn"
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle theme"
        >
          <Icon
            icon={theme === "dark" ? "solar:sun-2-linear" : "solar:moon-linear"}
            width={20}
            height={20}
          />
        </button>
        <button
          type="button"
          className="welcome__float-btn"
          onClick={pickFolder}
          disabled={picking}
          title="Open a folder"
          aria-label="Open a folder"
        >
          <Icon icon="solar:add-circle-linear" width={22} height={22} />
        </button>
      </div>

      <main className="welcome__stage">
        <header className="welcome__head">
          <span className="welcome__hero">
            <Claaky size={104} state="idle" decorative />
          </span>
          <h1 className="welcome__title">Claake Code</h1>
          <p className="welcome__tag">Your personal Agentic IDE</p>
          <button
            className="welcome__cta"
            onClick={pickFolder}
            disabled={picking}
          >
            <Icon icon="solar:folder-open-bold" width={16} height={16} />
            <span>{picking ? "Opening…" : "Open a folder"}</span>
          </button>
        </header>

        {error && (
          <div className="welcome__error">{error}</div>
        )}

        {recents.length > 0 ? (
          <section className="welcome__section">
            <h2 className="welcome__section-heading">Recent</h2>
            <div className="welcome__recents">
              {recents.slice(0, MAX_VISIBLE_RECENTS).map((recent) => {
                const isActive = activeWorkspaces.has(recent.path);
                return (
                  <button
                    key={recent.path}
                    className="welcome__recent"
                    data-active={isActive ? "true" : "false"}
                    onClick={() => onPick(recent.path)}
                  >
                    <span className="welcome__recent-icon">
                      <BlobAvatar seed={recent.path} size={46} />
                      {isActive && (
                        <span
                          className="welcome__recent-spinner"
                          role="status"
                          aria-label="Agent running"
                        />
                      )}
                    </span>
                    <span className="welcome__recent-body">
                      <span className="welcome__recent-line">
                        <span className="welcome__recent-name">
                          {recent.name || deriveName(recent.path)}
                        </span>
                        <span className="welcome__recent-time">
                          {isActive ? "agent actif" : shortRelativeTime(recent.lastOpenedMs)}
                        </span>
                      </span>
                      <span className="welcome__recent-path">{recent.path}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : (
          <div className="welcome__empty">
            No recent workspaces yet. Pick a folder to get started.
          </div>
        )}
      </main>
    </div>
  );
}
