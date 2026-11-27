import { useEffect, useState } from "react";
import { askApi, type AskConversation, type AskUser, type Project } from "../../ask/api";
import { accountsChanged, connectedAccounts } from "../../ask/models";
import { getKey } from "../../ask/openrouter";
import { NavBar, NavButton, Spinner, relativeTime } from "../../ui/common";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { SwipeRow } from "../Home";

export function Avatar({ user, size = 32 }: { user: AskUser; size?: number }) {
  return user.avatarUrl ? (
    <img className="avatar" src={user.avatarUrl} alt="" width={size} height={size} />
  ) : (
    <span className="avatar avatar--initial" style={{ width: size, height: size }}>
      {user.login.charAt(0).toUpperCase()}
    </span>
  );
}

export function ProjectTile({ name, index, size = 42 }: { name: string; index: number; size?: number }) {
  return (
    <span className="ask-tile" data-tone={index % 4} style={{ width: size, height: size, fontSize: size * 0.52 }} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "·"}
    </span>
  );
}

export function NameSheet({ open, title, action, initial = "", onClose, onSubmit }: {
  open: boolean;
  title: string;
  action: string;
  initial?: string;
  onClose(): void;
  onSubmit(name: string): Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <form
        className="ask-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          await onSubmit(name.trim());
          setBusy(false);
        }}
      >
        <input className="ask-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du projet" maxLength={80} enterKeyHint="done" />
        <button type="submit" className="button button--primary button--wide" disabled={!name.trim() || busy}>
          {busy ? <Spinner size={16} /> : action}
        </button>
      </form>
    </Sheet>
  );
}

export function AskHome({ user, active, onOpenProject, onOpenChat, onSettings, onError }: {
  user: AskUser;
  active: boolean;
  onOpenProject(id: string): void;
  onOpenChat(id: string | null, projectId: string | null): void;
  onSettings(): void;
  onError(err: unknown): void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [conversations, setConversations] = useState<AskConversation[] | null>(null);
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const hasModels = Boolean(getKey()) || subscribed;

  useEffect(() => {
    const check = () => void connectedAccounts().then((a) => setSubscribed(a.length > 0));
    check();
    accountsChanged.addEventListener("change", check);
    return () => accountsChanged.removeEventListener("change", check);
  }, []);

  useEffect(() => {
    if (!active) return;
    Promise.all([askApi.projects(), askApi.conversations()])
      .then(([p, c]) => {
        setProjects(p);
        setConversations(c);
      })
      .catch(onError);
  }, [active]);

  const needle = query.trim().toLowerCase();
  const names = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const shownProjects = (projects ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle));
  const shownConversations = (conversations ?? []).filter((c) => !needle || c.title.toLowerCase().includes(needle));
  const loading = projects === null || conversations === null;

  async function remove(id: string) {
    setConversations((list) => list?.filter((c) => c.id !== id) ?? null);
    await askApi.deleteConversation(id).catch(onError);
  }

  return (
    <div className="screen">
      <NavBar
        title="Conversations"
        showTitle={scrolled}
        left={
          <button type="button" className="nav-button nav-button--avatar" aria-label="Réglages" onClick={onSettings}>
            <Avatar user={user} size={34} />
          </button>
        }
        right={<NavButton icon="plus" label="Nouvelle conversation" onClick={() => onOpenChat(null, null)} />}
      />
      <div className="scroll" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}>
        <h1 className="large-title">Conversations</h1>
        {!hasModels && (
          <button type="button" className="ask-connect" onClick={onSettings}>
            <span className="ask-connect__icon"><Icon name="sparkle" size={20} /></span>
            <span className="ask-connect__text">
              <strong>Connecte un modèle</strong>
              <span>Ton abonnement Claude, ChatGPT, Gemini… ou OpenRouter, gratuit.</span>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        )}
        <label className="search">
          <Icon name="search" size={17} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher" type="search" enterKeyHint="search" />
        </label>

        <section className="group">
          <div className="group__head">
            <h2 className="group__title">Projets</h2>
          </div>
          <div className="ask-projects">
            <button type="button" className="ask-project ask-project--new" onClick={() => setCreating(true)}>
              <span className="ask-project__plus"><Icon name="plus" size={22} stroke={2.2} /></span>
              <strong>Nouveau projet</strong>
              <span>Conversations et documents</span>
            </button>
            {shownProjects.map((p, i) => (
              <button key={p.id} type="button" className="ask-project" style={{ "--i": i } as React.CSSProperties} onClick={() => onOpenProject(p.id)}>
                <ProjectTile name={p.name} index={i} />
                <strong>{p.name}</strong>
                <span>
                  {p.conversationCount} conv. · {p.documentCount} doc.
                </span>
              </button>
            ))}
          </div>
        </section>

        {loading && (
          <div className="empty">
            <Spinner />
          </div>
        )}
        {shownConversations.length > 0 && (
          <section className="group">
            <h2 className="group__title">Récentes</h2>
            <div className="group__body">
              {shownConversations.map((c) => (
                <SwipeRow key={c.id} onDelete={() => void remove(c.id)}>
                  <button type="button" className="row" onClick={() => onOpenChat(c.id, c.projectId)}>
                    <span className="row__icon" data-tone="chat">
                      <Icon name="bubble" size={18} />
                    </span>
                    <span className="row__text">
                      <strong>{c.title}</strong>
                      <span>
                        {relativeTime(c.updatedAtMs)}
                        {c.projectId && names.get(c.projectId) ? ` · ${names.get(c.projectId)}` : ""}
                      </span>
                    </span>
                    <span className="row__chevron"><Icon name="chevron" size={16} /></span>
                  </button>
                </SwipeRow>
              ))}
            </div>
          </section>
        )}
        {!loading && shownConversations.length === 0 && (
          <div className="empty">
            <Icon name="bubble" size={34} stroke={1.5} />
            <strong>{needle ? "Aucun résultat" : "Aucune conversation"}</strong>
            <span>{needle ? "Essaie un autre mot." : "Touche + pour poser ta première question."}</span>
          </div>
        )}
      </div>

      <NameSheet
        open={creating}
        title="Nouveau projet"
        action="Créer le projet"
        onClose={() => setCreating(false)}
        onSubmit={async (name) => {
          try {
            const project = await askApi.createProject(name);
            setCreating(false);
            onOpenProject(project.id);
          } catch (err) {
            onError(err);
          }
        }}
      />
    </div>
  );
}
