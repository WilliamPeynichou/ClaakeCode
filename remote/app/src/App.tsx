import { useEffect, useState } from "react";
import { ChatScreen } from "./screens/Chat";
import { HomeScreen } from "./screens/Home";
import { InstallScreen } from "./screens/Install";
import { LaunchScreen } from "./screens/Launch";
import { PairScreen } from "./screens/Pair";
import { SettingsScreen } from "./screens/Settings";
import { launchParams } from "./ask/launch";
import { AskGate, AskTab, AskToast, VoiceTab, useAskUser } from "./screens/ask/AskTab";
import { launchedFromNotification, useRemote, type Remote } from "./state";
import { Icon, type IconName } from "./ui/Icon";
import { SLIDE_MS, useEdgeSwipe } from "./ui/stack";

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

type Tab = "ask" | "voice" | "remote";
const TAB_KEY = "claake.tab";
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "ask", label: "Conversations", icon: "bubble" },
  { id: "voice", label: "Vocal", icon: "mic" },
  { id: "remote", label: "Remote", icon: "laptop" },
];

function initialTab(): Tab {
  if (launchedFromNotification) return "remote";
  if (launchParams.tab === "ask" || launchParams.openrouterCode || launchParams.authError) return "ask";
  const saved = localStorage.getItem(TAB_KEY);
  return saved === "voice" || saved === "remote" ? saved : "ask";
}

/** The Mac remote: pairing, then the conversations of the Mac's projects. */
function RemoteTab({ remote, onBar }: { remote: Remote; onBar(hidden: boolean): void }) {
  const [page, setPage] = useState<"settings" | null>(null);
  const [leaving, setLeaving] = useState(false);
  // The Mac project picker opens the first time the tab shows, unless a notification opened a chat.
  const [launching, setLaunching] = useState(!launchedFromNotification);
  const code = new URLSearchParams(location.search).get("code")?.replace(/\D/g, "").slice(0, 6) ?? "";
  const pushed = remote.currentId !== null ? "chat" : page;
  useEffect(() => {
    if (remote.currentId !== null) {
      setPage(null);
      setLaunching(false);
    }
  }, [remote.currentId]);
  const showLaunch = launching && Boolean(remote.session);
  useEffect(() => onBar(pushed !== null || showLaunch), [pushed, showLaunch]);
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

  if (!remote.session) return <PairScreen remote={remote} initialCode={code} />;

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
      {showLaunch && <LaunchScreen remote={remote} onDone={() => setLaunching(false)} />}
    </div>
  );
}

function TabBar({ tab, onTab }: { tab: Tab; onTab(tab: Tab): void }) {
  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className="tabbar__item"
          data-active={tab === t.id}
          aria-current={tab === t.id ? "page" : undefined}
          onClick={() => onTab(t.id)}
        >
          <Icon name={t.icon} size={22} stroke={tab === t.id ? 2.2 : 1.8} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function App() {
  const remote = useRemote();
  const ask = useAskUser();
  const [skipInstall, setSkipInstall] = useState(false);
  const [tab, setTab] = useState<Tab>(initialTab);
  // Tabs mount on first visit, then stay mounted so they keep their place.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([initialTab()]));
  const [hidden, setHidden] = useState<Record<Tab, boolean>>({ ask: false, voice: false, remote: false });
  useKeyboardInset();

  function open(next: Tab) {
    setTab(next);
    setVisited((v) => (v.has(next) ? v : new Set(v).add(next)));
    localStorage.setItem(TAB_KEY, next);
  }
  // A tapped notification opens its Mac conversation.
  useEffect(() => {
    if (remote.currentId !== null) open("remote");
  }, [remote.currentId]);

  if (!remote.session && isIos() && !isStandalone() && !skipInstall) {
    const code = new URLSearchParams(location.search).get("code")?.replace(/\D/g, "").slice(0, 6) ?? "";
    return <InstallScreen code={code || null} onSkip={() => setSkipInstall(true)} />;
  }

  const barHidden = hidden[tab];
  const bar = (id: Tab) => (value: boolean) => setHidden((h) => (h[id] === value ? h : { ...h, [id]: value }));
  return (
    <div className="tabs" data-bar={!barHidden}>
      {visited.has("ask") && (
        <div className="tab-panel" hidden={tab !== "ask"}>
          <AskGate ask={ask}>{(user) => <AskTab ask={ask} user={user} active={tab === "ask"} onBar={bar("ask")} />}</AskGate>
        </div>
      )}
      {visited.has("voice") && (
        <div className="tab-panel" hidden={tab !== "voice"}>
          <VoiceTab ask={ask} active={tab === "voice"} />
        </div>
      )}
      {visited.has("remote") && (
        <div className="tab-panel" hidden={tab !== "remote"}>
          <RemoteTab remote={remote} onBar={bar("remote")} />
        </div>
      )}
      {!barHidden && <TabBar tab={tab} onTab={open} />}
      {tab === "remote" && remote.error ? (
        <button type="button" className="toast" onClick={remote.actions.clearError}>
          <Icon name="warning" size={17} />
          <span>{remote.error}</span>
        </button>
      ) : (
        tab !== "remote" && <AskToast ask={ask} />
      )}
    </div>
  );
}
