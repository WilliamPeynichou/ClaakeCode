import { useRef, useState } from "react";
import type { ConversationSummary } from "../protocol/types";
import type { Remote } from "../state";
import { ConnectionBanner, NavBar, NavButton, Spinner, conversationTitle, relativeTime } from "../ui/common";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";

const DELETE_WIDTH = 92;

export function SwipeRow({ children, onDelete }: { children: React.ReactNode; onDelete(): void }) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number; base: number; horizontal: boolean | null } | null>(null);

  return (
    <div className="swipe-row">
      <button type="button" className="swipe-row__delete" onClick={onDelete} style={{ width: DELETE_WIDTH }}>
        <Icon name="trash" size={20} />
        Supprimer
      </button>
      <div
        className="swipe-row__content"
        style={{ transform: `translateX(${offset}px)`, transition: start.current ? "none" : undefined }}
        onTouchStart={(e) => (start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, base: offset, horizontal: null })}
        onTouchMove={(e) => {
          const s = start.current;
          if (!s) return;
          const dx = e.touches[0].clientX - s.x;
          const dy = e.touches[0].clientY - s.y;
          if (s.horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) s.horizontal = Math.abs(dx) > Math.abs(dy);
          if (s.horizontal) setOffset(Math.min(0, Math.max(-DELETE_WIDTH * 1.4, s.base + dx)));
        }}
        onTouchEnd={() => {
          start.current = null;
          setOffset((value) => (value < -DELETE_WIDTH / 2 ? -DELETE_WIDTH : 0));
        }}
        onClickCapture={(e) => {
          if (offset !== 0) {
            e.stopPropagation();
            setOffset(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ConversationRow({ conversation, running, onOpen }: { conversation: ConversationSummary; running: boolean; onOpen(): void }) {
  const rlm = conversation.harness === "rlm";
  return (
    <button type="button" className="row" onClick={onOpen}>
      <span className="row__icon" data-tone={rlm ? "rlm" : "chat"}>
        <Icon name={rlm ? "cube" : "bubble"} size={18} />
      </span>
      <span className="row__text">
        <strong>{conversationTitle(conversation.title)}</strong>
        <span>
          {running ? "L'agent travaille…" : relativeTime(conversation.updatedAtMs)}
          {rlm ? " · RLM" : ""}
        </span>
      </span>
      {running ? <Spinner size={16} /> : <span className="row__chevron"><Icon name="chevron" size={16} /></span>}
    </button>
  );
}

export function HomeScreen({ remote, onOpen, onSettings }: {
  remote: Remote;
  onOpen(id: string): void;
  onSettings(): void;
}) {
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const project = remote.workspaces.find((w) => w.path === remote.workspacePath);
  const running = new Set(remote.activeTurns.map((turn) => turn.conversationId));
  const needle = query.trim().toLowerCase();
  const visible = remote.conversations.filter((c) => !needle || conversationTitle(c.title).toLowerCase().includes(needle));
  const active = visible.filter((c) => running.has(c.id));
  const recent = visible.filter((c) => !running.has(c.id));

  async function create(harness: "classic" | "rlm") {
    setNewOpen(false);
    setCreating(true);
    await remote.actions.createConversation(harness);
    setCreating(false);
  }

  const section = (title: string, items: ConversationSummary[]) =>
    items.length > 0 && (
      <section className="group">
        <h2 className="group__title">{title}</h2>
        <div className="group__body">
          {items.map((c) => (
            <SwipeRow key={c.id} onDelete={() => void remote.actions.deleteConversation(c.id)}>
              <ConversationRow conversation={c} running={running.has(c.id)} onOpen={() => onOpen(c.id)} />
            </SwipeRow>
          ))}
        </div>
      </section>
    );

  return (
    <div className="screen">
      <NavBar
        title="Conversations"
        showTitle={scrolled}
        left={<NavButton icon="gear" label="Réglages" onClick={onSettings} />}
        right={
          creating ? (
            <Spinner />
          ) : (
            <NavButton
              icon="plus"
              label="Nouvelle conversation"
              disabled={!remote.synced}
              onClick={() => (remote.rlmAvailable ? setNewOpen(true) : void create("classic"))}
            />
          )
        }
      />
      <div className="scroll" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}>
        <h1 className="large-title">Conversations</h1>
        <button type="button" className="project-pill" onClick={() => setProjectsOpen(true)} disabled={remote.workspaces.length < 2}>
          <Icon name="folder" size={16} />
          <span>{project?.name ?? "Projet"}</span>
          {remote.workspaces.length > 1 && <Icon name="down" size={14} stroke={2.4} />}
        </button>
        <ConnectionBanner connection={remote.connection} />
        <label className="search">
          <Icon name="search" size={17} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher" type="search" enterKeyHint="search" />
        </label>
        {!remote.synced && remote.connection.mac && (
          <div className="empty">
            <Spinner />
          </div>
        )}
        {section("En cours", active)}
        {section(active.length > 0 ? "Récentes" : "Conversations", recent)}
        {remote.synced && visible.length === 0 && (
          <div className="empty">
            <Icon name="bubble" size={34} stroke={1.5} />
            <strong>{needle ? "Aucun résultat" : "Aucune conversation"}</strong>
            <span>{needle ? "Essaie un autre mot." : "Touche + pour donner une tâche à ton agent."}</span>
          </div>
        )}
      </div>

      <Sheet open={projectsOpen} title="Projets ouverts sur le Mac" onClose={() => setProjectsOpen(false)}>
        <div className="group__body">
          {remote.workspaces.map((w) => (
            <button
              key={w.path}
              type="button"
              className="row"
              onClick={() => {
                setProjectsOpen(false);
                void remote.actions.selectWorkspace(w.path);
              }}
            >
              <span className="row__icon" data-tone="folder">
                <Icon name="folder" size={18} />
              </span>
              <span className="row__text">
                <strong>{w.name}</strong>
                <span>{w.path}</span>
              </span>
              {w.path === remote.workspacePath && <span className="row__check"><Icon name="check" size={18} stroke={2.4} /></span>}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={newOpen} title="Nouvelle conversation" onClose={() => setNewOpen(false)}>
        <div className="group__body">
          <button type="button" className="row" onClick={() => void create("classic")}>
            <span className="row__icon" data-tone="chat">
              <Icon name="bubble" size={18} />
            </span>
            <span className="row__text">
              <strong>Chat</strong>
              <span>L'agent classique de Claake Code.</span>
            </span>
          </button>
          <button type="button" className="row" onClick={() => void create("rlm")}>
            <span className="row__icon" data-tone="rlm">
              <Icon name="cube" size={18} />
            </span>
            <span className="row__text">
              <strong>RLM</strong>
              <span>Agent Prime avec Python persistant, dans un worktree Git.</span>
            </span>
          </button>
        </div>
      </Sheet>
    </div>
  );
}
