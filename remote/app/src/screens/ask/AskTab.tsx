import { useEffect, useState } from "react";
import { ApiError, askApi, type AskUser } from "../../ask/api";
import { launchParams } from "../../ask/launch";
import { finishConnect } from "../../ask/openrouter";
import { Spinner } from "../../ui/common";
import { Icon } from "../../ui/Icon";
import { useEdgeSwipe, useStack } from "../../ui/stack";
import { AskChat } from "./AskChat";
import { AskHome } from "./AskHome";
import { AskProject } from "./AskProject";
import { AskSettings } from "./AskSettings";
import { AskSignIn } from "./AskSignIn";
import "./ask.css";

type Route = { kind: "home" } | { kind: "project"; id: string } | { kind: "chat"; id: string | null; projectId: string | null };

/** The signed-in user, shared by the Conversations and Vocal tabs. undefined while loading, null when signed out. */
export function useAskUser() {
  const [user, setUser] = useState<AskUser | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** Set once the key from OpenRouter's consent page is saved. */
  const [openrouterConnected, setOpenrouterConnected] = useState(false);
  useEffect(() => {
    askApi
      .me()
      .then(setUser)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setUser(null);
        else {
          setUser(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    if (launchParams.openrouterCode) {
      finishConnect(launchParams.openrouterCode)
        .then(() => setOpenrouterConnected(true))
        .catch((err) => setError(String(err?.message ?? err)));
    }
  }, []);

  /** Shows the error; a lost session sends the user back to the sign-in screen. */
  function fail(err: unknown) {
    if (err instanceof ApiError && err.status === 401) setUser(null);
    else setError(err instanceof Error ? err.message : String(err));
  }

  async function signOut() {
    await askApi.logout().catch(() => undefined);
    setUser(null);
  }

  return { user, error, openrouterConnected, fail, clearError: () => setError(null), signOut };
}

export type AskUserState = ReturnType<typeof useAskUser>;

export function AskGate({ ask, children }: { ask: AskUserState; children(user: AskUser): React.ReactNode }) {
  if (ask.user === undefined) {
    return (
      <div className="screen ask-loading">
        <Spinner size={22} />
      </div>
    );
  }
  if (ask.user === null) return <AskSignIn error={launchParams.authError} />;
  return <>{children(ask.user)}</>;
}

export function AskTab({ ask, user, active, onBar }: { ask: AskUserState; user: AskUser; active: boolean; onBar(hidden: boolean): void }) {
  const stack = useStack<Route>({ kind: "home" });
  const [settings, setSettings] = useState(false);
  const swipe = useEdgeSwipe(stack.routes.length > 1 && !stack.leaving, stack.pop);
  const chatOnTop = stack.top.kind === "chat";

  useEffect(() => onBar(chatOnTop), [chatOnTop]);
  // Back from OpenRouter's consent page: reopen the settings so the user sees it worked.
  useEffect(() => {
    if (ask.openrouterConnected) setSettings(true);
  }, [ask.openrouterConnected]);

  const openChat = (id: string | null, projectId: string | null) => stack.push({ kind: "chat", id, projectId });

  return (
    <div className="stack" {...swipe.handlers}>
      {stack.routes.map(({ key, route }, index) => {
        const depth = stack.depth(index);
        const front = depth === "front" && active;
        const isTop = index === stack.routes.length - 1;
        return (
          <div
            key={key}
            className={index ? "stack__screen stack__screen--pushed" : "stack__screen"}
            data-depth={depth === "hidden" ? "behind" : depth}
            hidden={depth === "hidden"}
            style={isTop && index > 0 && swipe.offset ? { transform: `translateX(${swipe.offset}px)`, transition: "none" } : undefined}
          >
            {route.kind === "home" && (
              <AskHome
                user={user}
                active={front}
                onOpenProject={(id) => stack.push({ kind: "project", id })}
                onOpenChat={openChat}
                onSettings={() => setSettings(true)}
                onError={ask.fail}
              />
            )}
            {route.kind === "project" && (
              <AskProject projectId={route.id} active={front} onBack={stack.pop} onOpenChat={openChat} onError={ask.fail} />
            )}
            {route.kind === "chat" && (
              <AskChat
                conversationId={route.id}
                projectId={route.projectId}
                active={front}
                onBack={stack.pop}
                onCreated={(c) => stack.replace({ kind: "chat", id: c.id, projectId: c.projectId })}
                onSettings={() => setSettings(true)}
                onError={ask.fail}
              />
            )}
          </div>
        );
      })}
      <AskSettings open={settings} user={user} onClose={() => setSettings(false)} onSignOut={() => void ask.signOut()} onError={ask.fail} />
    </div>
  );
}

/** The Vocal tab: one voice conversation at a time, answers read aloud. */
export function VoiceTab({ ask, active }: { ask: AskUserState; active: boolean }) {
  const [round, setRound] = useState(0);
  const [settings, setSettings] = useState(false);
  return (
    <AskGate ask={ask}>
      {(user) => (
        <>
          <AskChat
            key={round}
            conversationId={null}
            projectId={null}
            voiceOnly
            active={active}
            onNew={() => setRound((n) => n + 1)}
            onSettings={() => setSettings(true)}
            onError={ask.fail}
          />
          <AskSettings open={settings} user={user} onClose={() => setSettings(false)} onSignOut={() => void ask.signOut()} onError={ask.fail} />
        </>
      )}
    </AskGate>
  );
}

export function AskToast({ ask }: { ask: AskUserState }) {
  if (!ask.error) return null;
  return (
    <button type="button" className="toast" onClick={ask.clearError}>
      <Icon name="warning" size={17} />
      <span>{ask.error}</span>
    </button>
  );
}
