import { useEffect, useRef, useState } from "react";
import { ChatScreen } from "./screens/Chat";
import { HomeScreen } from "./screens/Home";
import { InstallScreen } from "./screens/Install";
import { LaunchScreen } from "./screens/Launch";
import { PairScreen } from "./screens/Pair";
import { SettingsScreen } from "./screens/Settings";
import { launchedFromNotification, useRemote } from "./state";
import { Icon } from "./ui/Icon";

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Keeps the composer above the iOS keyboard: the layout viewport does not shrink when it opens. */
function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--keyboard", `${inset}px`);
      document.documentElement.dataset.keyboard = inset > 80 ? "open" : "closed";
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
}

/** Swipe from the left edge to go back, like a native navigation stack. */
function useEdgeSwipe(enabled: boolean, onBack: () => void) {
  const [offset, setOffset] = useState(0);
  const start = useRef<number | null>(null);
  const handlers = {
    onTouchStart: (e: React.TouchEvent) => {
      if (enabled && e.touches[0].clientX < 24) start.current = e.touches[0].clientX;
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (start.current !== null) setOffset(Math.max(0, e.touches[0].clientX - start.current));
    },
    onTouchEnd: () => {
      if (start.current !== null && offset > 90) onBack();
      start.current = null;
      setOffset(0);
    },
  };
  return { offset, handlers };
}

const SLIDE_MS = 320;

export function App() {
  const remote = useRemote();
  const [page, setPage] = useState<"settings" | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [skipInstall, setSkipInstall] = useState(false);
  // The project picker opens each time the app launches, unless a notification opened a chat.
  const [launching, setLaunching] = useState(!launchedFromNotification);
  const code = new URLSearchParams(location.search).get("code")?.replace(/\D/g, "").slice(0, 6) ?? "";
  const pushed = remote.currentId !== null ? "chat" : page;
  useEffect(() => {
    if (remote.currentId !== null) {
      setPage(null);
      setLaunching(false);
    }
  }, [remote.currentId]);
  // The pushed screen keeps its content while it slides away.
  const back = () => {
    if (!pushed || leaving) return;
    setLeaving(true);
    window.setTimeout(() => {
      if (pushed === "chat") remote.actions.closeConversation();
      else setPage(null);
      setLeaving(false);
    }, SLIDE_MS);
  };
  const swipe = useEdgeSwipe(Boolean(pushed) && !leaving, back);
  useKeyboardInset();

  if (!remote.session) {
    if (isIos() && !isStandalone() && !skipInstall) return <InstallScreen code={code || null} onSkip={() => setSkipInstall(true)} />;
    return <PairScreen remote={remote} initialCode={code} />;
  }

  const front = pushed !== null && !leaving;
  return (
    <div className="stack" {...swipe.handlers}>
      <div className="stack__screen" data-depth={front ? "behind" : "front"}>
        <HomeScreen
          remote={remote}
          onOpen={(id) => void remote.actions.openConversation(id)}
          onSettings={() => setPage("settings")}
        />
      </div>
      <div
        className="stack__screen stack__screen--pushed"
        data-depth={front ? "front" : "away"}
        style={swipe.offset ? { transform: `translateX(${swipe.offset}px)`, transition: "none" } : undefined}
      >
        {pushed === "chat" && <ChatScreen remote={remote} onBack={back} />}
        {pushed === "settings" && <SettingsScreen remote={remote} onBack={back} />}
      </div>
      {launching && <LaunchScreen remote={remote} onDone={() => setLaunching(false)} />}
      {remote.error && (
        <button type="button" className="toast" onClick={remote.actions.clearError}>
          <Icon name="warning" size={17} />
          <span>{remote.error}</span>
        </button>
      )}
    </div>
  );
}
