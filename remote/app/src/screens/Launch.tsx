import { useEffect, useRef, useState } from "react";
import type { WorkspaceInfo } from "../protocol/types";
import type { Remote } from "../state";
import { Icon } from "../ui/Icon";
import { PixelScene, type SceneAnchor } from "../ui/PixelScene";
import "./launch.css";

const PICK_MS = 380;
const EXIT_MS = 680;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Types the text out like a terminal, and restarts when it changes. */
function useTyped(text: string) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return setCount(text.length);
    setCount(0);
    const timer = window.setInterval(() => {
      setCount((value) => {
        if (value >= text.length) window.clearInterval(timer);
        return Math.min(text.length, value + 1);
      });
    }, 26);
    return () => window.clearInterval(timer);
  }, [text]);
  return { shown: text.slice(0, count), done: count >= text.length };
}

const shortPath = (path: string) => path.replace(/^\/Users\/[^/]+/, "~").replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");

function greeting() {
  const hour = new Date().getHours();
  return hour >= 18 || hour < 5 ? "Bonsoir !" : "Salut !";
}

function bubbleText(remote: Remote, chosen: WorkspaceInfo | undefined) {
  if (chosen) return `C'est parti sur ${chosen.name} !`;
  if (remote.connection.relay === "connecting") return "Je cherche ton Mac…";
  if (!remote.connection.mac) return "Ton Mac ne répond pas. Ouvre Claake Code dessus.";
  if (!remote.synced) return "Je me connecte à ton Mac…";
  return `${greeting()} On travaille sur quoi ?`;
}

function ProjectRow({ workspace, index, current, chosen, running, onPick }: {
  workspace: WorkspaceInfo;
  index: number;
  current: boolean;
  chosen: boolean;
  running: number;
  onPick(): void;
}) {
  return (
    <button
      type="button"
      className="launch__project"
      style={{ "--i": index } as React.CSSProperties}
      data-chosen={chosen}
      onClick={onPick}
    >
      <span className="launch__tile" data-tone={index % 4} aria-hidden="true">
        {workspace.name.trim().charAt(0).toUpperCase() || "·"}
      </span>
      <span className="launch__project-text">
        <strong>{workspace.name}</strong>
        <span>{shortPath(workspace.path)}</span>
      </span>
      {running > 0 ? (
        <span className="launch__badge" data-tone="live">
          <i aria-hidden="true" />
          {running > 1 ? `${running} tâches` : "En cours"}
        </span>
      ) : (
        current && <span className="launch__badge">Dernier</span>
      )}
      <span className="launch__go" aria-hidden="true">
        <Icon name={chosen ? "check" : "chevron"} size={16} stroke={2.4} />
      </span>
    </button>
  );
}

/** The opening screen: Claaky's pixel meadow, then the project to work on. */
export function LaunchScreen({ remote, onDone }: { remote: Remote; onDone(): void }) {
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [excited, setExcited] = useState(0);
  const [anchor, setAnchor] = useState<SceneAnchor | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const chosen = remote.workspaces.find((w) => w.path === chosenPath);
  const bubble = useTyped(bubbleText(remote, chosen));
  const ready = remote.synced && remote.connection.mac;

  function leave(delay: number) {
    timers.current.push(
      window.setTimeout(() => setLeaving(true), delay),
      window.setTimeout(onDone, delay + EXIT_MS),
    );
  }

  function pick(workspace: WorkspaceInfo) {
    if (chosenPath || leaving) return;
    setChosenPath(workspace.path);
    setExcited((n) => n + 1);
    navigator.vibrate?.(8);
    void remote.actions.selectWorkspace(workspace.path);
    leave(PICK_MS);
  }

  return (
    <div className="launch" data-leaving={leaving}>
      <PixelScene leaving={leaving} excited={excited} headroom={136} onAnchor={setAnchor}>
        <div className="launch__status" data-online={remote.connection.mac}>
          <i aria-hidden="true" />
          {remote.connection.mac ? "Mac connecté" : remote.connection.relay === "connecting" ? "Connexion…" : "Mac hors ligne"}
        </div>
        {anchor && (
          <p
            className="launch__bubble"
            style={{ "--x": `${anchor.x}px`, "--y": `${anchor.y}px` } as React.CSSProperties}
            aria-live="polite"
          >
            <span className="launch__bubble-body">
              {bubble.shown}
              {!bubble.done && <span className="launch__caret" aria-hidden="true" />}
            </span>
          </p>
        )}
      </PixelScene>

      <section className="launch__sheet" aria-labelledby="launch-title">
        <p className="launch__eyebrow">Claake Code · Remote</p>
        <h1 id="launch-title" className="launch__title">
          <span>Sur quel</span> <em>projet&nbsp;?</em>
        </h1>
        <p className="launch__lead">Les projets ouverts dans Claake Code sur ton Mac.</p>
        <div className="launch__list">
          {ready
            ? remote.workspaces.map((w, index) => (
                <ProjectRow
                  key={w.path}
                  workspace={w}
                  index={index}
                  current={w.path === remote.workspacePath}
                  chosen={w.path === chosenPath}
                  running={remote.activeTurns.filter((turn) => turn.workspaceId === w.path).length}
                  onPick={() => pick(w)}
                />
              ))
            : [0, 1].map((i) => <div key={i} className="launch__skeleton" style={{ "--i": i } as React.CSSProperties} />)}
        </div>
        <button type="button" className="launch__skip" onClick={() => leave(0)} disabled={leaving}>
          Voir les conversations
        </button>
      </section>
    </div>
  );
}
