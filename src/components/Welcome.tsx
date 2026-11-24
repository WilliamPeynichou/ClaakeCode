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
import { shortRelativeTime } from "./BlobAvatar";
import { Claaky } from "./claaky/Claaky";
import { WelcomeArt } from "./WelcomeArt";
import { useTheme } from "../lib/theme";

type Props = {
  onPick: (path: string) => void;
  error: string | null;
  deriveName: (path: string) => string;
};

const MAX_VISIBLE_RECENTS = 5;
const REPO_URL = "https://github.com/WilliamPeynichou/ClaakeCode";
const SITE_URL = "https://claakecode-web.vercel.app/whats-new";
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
      <section className="welcome__pane">
        <header className="welcome__top" data-tauri-drag-region>
          <span className="welcome__logo" aria-label="Claake Code">
            <Claaky size={34} state="idle" decorative />
            <span className="welcome__logo-name">Claake Code</span>
          </span>
          <nav className="welcome__nav">
            <button
              type="button"
              className="welcome__icon-btn"
              onClick={toggleTheme}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle theme"
            >
              <Icon
                icon={theme === "dark" ? "solar:sun-2-linear" : "solar:moon-linear"}
                width={16}
                height={16}
              />
            </button>
            <button
              type="button"
              className="welcome__icon-btn"
              onClick={() => void api.openExternalUrl(REPO_URL).catch(() => {})}
              title="Claake Code on GitHub"
              aria-label="Claake Code on GitHub"
            >
              <Icon icon="local:github" width={16} height={16} />
            </button>
            <button
              type="button"
              className="welcome__icon-btn"
              onClick={() => void api.openExternalUrl(SITE_URL).catch(() => {})}
              title="What's new"
              aria-label="What's new"
            >
              <Icon icon="solar:stars-linear" width={16} height={16} />
            </button>
            <button
              type="button"
              className="welcome__outline-btn"
              onClick={pickFolder}
              disabled={picking}
            >
              Open a folder
            </button>
          </nav>
        </header>

        <main className="welcome__content">
          <p className="welcome__crumb">
            {String(recents.length).padStart(2, "0")}
            <span aria-hidden="true">/</span>
            Workspaces
          </p>
          <h1 className="welcome__title">Open a workspace</h1>
          <p className="welcome__lead">
            Pick up a recent project or open any folder.
            <br />
            Claaky indexes it and gets your agents ready to work.
          </p>

          {error && <div className="welcome__error">{error}</div>}

          {recents.length > 0 && (
            <div className="welcome__fields">
              {recents.slice(0, MAX_VISIBLE_RECENTS).map((recent) => {
                const isActive = activeWorkspaces.has(recent.path);
                return (
                  <button
                    key={recent.path}
                    type="button"
                    className="welcome__field"
                    data-active={isActive ? "true" : "false"}
                    onClick={() => onPick(recent.path)}
                  >
                    <span className="welcome__field-label">
                      {recent.name || deriveName(recent.path)}
                      {isActive && (
                        <span
                          className="welcome__field-live"
                          role="status"
                          aria-label="Agent running"
                        />
                      )}
                    </span>
                    <span className="welcome__field-value">{recent.path}</span>
                    <span className="welcome__field-meta">
                      {isActive ? "agent actif" : shortRelativeTime(recent.lastOpenedMs)}
                      <Icon icon="solar:arrow-right-linear" width={14} height={14} />
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="welcome__actions">
            {recents.length > 0 ? (
              <button
                type="button"
                className="welcome__cta"
                onClick={() => onPick(recents[0].path)}
              >
                Reopen {recents[0].name || deriveName(recents[0].path)}
              </button>
            ) : (
              <button
                type="button"
                className="welcome__cta"
                onClick={pickFolder}
                disabled={picking}
              >
                {picking ? "Opening…" : "Open a folder"}
              </button>
            )}
          </div>
          <p className="welcome__note">
            <Icon icon="solar:info-circle-linear" width={16} height={16} />
            Recent workspaces are kept on this device only.
          </p>
        </main>
      </section>

      <aside className="welcome__art" aria-hidden="true">
        <WelcomeArt />
      </aside>
    </div>
  );
}
