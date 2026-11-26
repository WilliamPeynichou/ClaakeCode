import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RemoteClient, type Connection, type Session } from "./protocol/client";
import type {
  ActiveTurnReplay,
  ActiveTurnSummary,
  AgentEvent,
  AgentMode,
  Attachment,
  BootstrapResponse,
  ConversationSummary,
  ModelRef,
  ModelsResponse,
  PcPayload,
  PhoneCommand,
  PhoneThinking,
  SavedConversation,
  WorkspaceBootstrap,
  WorkspaceInfo,
} from "./protocol/types";
import { fromBase64Url } from "./protocol/crypto";
import type { PlanArtifact } from "../../../src/types";

export type ModelEntry = { provider: string; name: string; label: string; thinking: PhoneThinking[]; defaultThinking: PhoneThinking };

export type Draft = { text: string; attachments: Attachment[] };

export type Settings = {
  /** Ask the agent for a short <spoken> report at the end of each task. */
  synthesis: boolean;
  /** Read new reports aloud while the app is open. */
  readAloud: boolean;
};

type SendExtra = Pick<Extract<PhoneCommand, { type: "send_message" }>, "plan_control" | "message_visibility">;

const SETTINGS_KEY = "claake.remote.settings.v1";
const WORKSPACE_KEY = "claake.remote.workspace.v1";
const THINKING: PhoneThinking[] = ["off", "low", "medium", "high", "xhigh", "max"];
// Same prompts as the desktop plan card (src/components/chat/ChatPane.tsx).
const IMPLEMENT_PLAN_PROMPT = "Implement completely this plan. Use the attached plan as the source of truth.";
const KEEP_PLANNING_PROMPT =
  "No, keep updating the plan. Use the attached plan as the current draft, ask any useful follow-up questions, then rewrite the plan when ready.";
/** Events without a sequence (outside a registered turn) sort after the sequenced ones. */
const UNSEQUENCED = 1e12;

function loadSettings(): Settings {
  const defaults: Settings = { synthesis: true, readAloud: false };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return defaults;
  }
}

export function thinkingOf(model: ModelRef | null | undefined): PhoneThinking {
  if (!model) return "medium";
  if (model.effort === "none") return "off";
  if (model.effort && THINKING.includes(model.effort)) return model.effort;
  return model.provider === "google" || model.provider === "kimi" ? "high" : "medium";
}

/** Google ids carry the thinking level as a suffix on the Mac side. */
const modelKey = (provider: string, name: string) =>
  `${provider}:${provider === "google" ? name.replace(/-(low|medium|high)$/, "") : name}`;

export function modelEntries(models: ModelsResponse | null): ModelEntry[] {
  if (!models) return [];
  const configured = new Set(models.providers);
  const levels = (values: string[]) => values.filter((v): v is PhoneThinking => THINKING.includes(v as PhoneThinking));
  const entries: ModelEntry[] = models.modelCatalog
    .filter((m) => !m.hidden && configured.has(m.provider))
    .map((m) => ({
      provider: m.provider,
      name: m.id,
      label: m.label,
      thinking: levels(m.thinking),
      defaultThinking: levels([m.defaultThinking])[0] ?? "medium",
    }));
  if (configured.has("openrouter")) {
    for (const m of models.openrouterModels) {
      entries.push({
        provider: "openrouter",
        name: m.id,
        label: m.name.includes(":") ? m.name.slice(m.name.indexOf(":") + 1).trim() : m.name,
        thinking: m.supportsThinking ? ["off", "low", "medium", "high", "xhigh"] : ["off"],
        defaultThinking: m.supportsThinking ? "medium" : "off",
      });
    }
  }
  return entries;
}

export function findEntry(entries: ModelEntry[], model: ModelRef | null | undefined): ModelEntry | null {
  if (!model) return null;
  const key = modelKey(model.provider, model.name);
  return entries.find((entry) => modelKey(entry.provider, entry.name) === key) ?? null;
}

export function modeOf(conversation: SavedConversation | null): AgentMode {
  if (!conversation) return "act";
  if (conversation.planWorkflow.status !== "idle") return "plan";
  if (conversation.goalWorkflow.status === "active") return "goal";
  return "act";
}

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Set when a tapped notification launches the app. */
const launchLink = (() => {
  const params = new URLSearchParams(location.search);
  const conversation = params.get("conversation");
  if (!conversation) return null;
  history.replaceState(null, "", "/");
  return { workspace: params.get("workspace"), conversation };
})();

export function useRemote() {
  const [session, setSession] = useState<Session | null>(null);
  const [connection, setConnection] = useState<Connection>({ relay: "connecting", mac: false });
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(() => localStorage.getItem(WORKSPACE_KEY));
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeTurns, setActiveTurns] = useState<ActiveTurnSummary[]>([]);
  const [rlmAvailable, setRlmAvailable] = useState(false);
  const [synced, setSynced] = useState(false);
  const [open, setOpen] = useState<SavedConversation | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [eventsVersion, setEventsVersion] = useState(0);
  const [mode, setModeState] = useState<AgentMode>("act");
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [queued, setQueued] = useState<Record<string, Draft>>({});
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = useRef<RemoteClient | null>(null);
  /** The conversation the user is looking at (set before it finishes loading). */
  const wanted = useRef<string | null>(null);
  const [initialDraft, setInitialDraft] = useState<{ id: string; text: string } | null>(null);
  /** Events of the running turn of `wanted`, by sequence: live events and replays merge without duplicates. */
  const liveEvents = useRef(new Map<number, AgentEvent>());
  /** The error or stop of the last finished turn: the saved history keeps no trace of them. */
  const ending = useRef<AgentEvent[]>([]);
  const unsequenced = useRef(UNSEQUENCED);
  const workspaceRef = useRef(workspacePath);
  const vapidKey = useRef<string | null>(null);
  const pendingLink = useRef(launchLink);
  const latest = useRef({ open, queued, settings, mode });
  latest.current = { open, queued, settings, mode };
  workspaceRef.current = workspacePath;

  const command = useCallback(<T,>(cmd: PhoneCommand) => {
    if (!client.current) return Promise.reject(new Error("Pas encore connecté."));
    return client.current.command<T>(cmd, workspaceRef.current);
  }, []);

  const fail = useCallback((err: unknown) => setError(err instanceof Error ? err.message : String(err)), []);

  const want = useCallback((id: string | null) => {
    wanted.current = id;
    setCurrentId(id);
    setInitialDraft((draft) => draft?.id === id ? draft : null);
  }, []);

  const resetEvents = useCallback(() => {
    liveEvents.current = new Map();
    ending.current = [];
    unsequenced.current = UNSEQUENCED;
    setEventsVersion((v) => v + 1);
  }, []);

  const addEvent = useCallback((sequence: number | null | undefined, event: AgentEvent) => {
    if (event.type === "turn_started") ending.current = [];
    liveEvents.current.set(sequence ?? unsequenced.current++, event);
    setEventsVersion((v) => v + 1);
  }, []);

  const applyBootstrap = useCallback((data: BootstrapResponse) => {
    workspaceRef.current = data.workspacePath;
    setWorkspacePath(data.workspacePath);
    localStorage.setItem(WORKSPACE_KEY, data.workspacePath);
    setWorkspaces(data.workspaces);
    setConversations(data.bootstrap.conversations);
    setActiveTurns(data.activeTurns);
    setRlmAvailable(Boolean(data.rlmAvailable));
    setSynced(true);
  }, []);

  /** Loads a conversation and, if its turn is running, the events emitted so far. */
  const loadConversation = useCallback(
    async (id: string, running: boolean) => {
      const conversation = await command<SavedConversation>({ type: "load_conversation", conversation_id: id });
      if (wanted.current !== id) return;
      if (latest.current.open?.id !== id) setModeState(modeOf(conversation));
      setOpen(conversation);
      if (!running) return;
      const replay = await command<ActiveTurnReplay>({ type: "replay_active_turn_events", conversation_id: id, after_sequence: 0 });
      if (wanted.current !== id) return;
      for (const entry of replay.events) liveEvents.current.set(entry.sequence, entry.event);
      setEventsVersion((v) => v + 1);
    },
    [command],
  );

  const appendUserMessage = useCallback((conversationId: string, text: string) => {
    ending.current = [];
    setEventsVersion((v) => v + 1);
    setOpen((current) =>
      current && current.id === conversationId
        ? { ...current, history: [...current.history, { role: "user", parts: [{ type: "text", text }] }] }
        : current,
    );
  }, []);

  const sendDraft = useCallback(
    async (conversation: SavedConversation, draft: Draft, sendMode: AgentMode, extra: SendExtra = {}) => {
      const model = conversation.modeModelSettings?.[sendMode] ?? conversation.model;
      await command({
        type: "send_message",
        conversation_id: conversation.id,
        text: draft.text,
        attachments: draft.attachments,
        mode: sendMode,
        model: { provider: model.provider, name: model.name },
        thinking: thinkingOf(model),
        voice: latest.current.settings.synthesis,
        ...extra,
      });
    },
    [command],
  );

  const refreshList = useCallback(async () => {
    try {
      setConversations(await command<ConversationSummary[]>({ type: "list_conversations" }));
    } catch (err) {
      fail(err);
    }
  }, [command, fail]);

  const onTurnFinished = useCallback(
    async (conversationId: string) => {
      void refreshList();
      if (wanted.current !== conversationId) return;
      try {
        const fresh = await command<SavedConversation>({ type: "load_conversation", conversation_id: conversationId });
        if (wanted.current !== conversationId) return;
        const endings = [...liveEvents.current.values()].filter((event) => event.type === "error" || event.type === "interrupted");
        setOpen(fresh);
        resetEvents();
        ending.current = endings;
        const draft = latest.current.queued[conversationId];
        if (!draft) return;
        setQueued(({ [conversationId]: _sent, ...rest }) => rest);
        appendUserMessage(conversationId, draft.text);
        await sendDraft(fresh, draft, latest.current.mode);
      } catch (err) {
        fail(err);
      }
    },
    [appendUserMessage, command, fail, refreshList, resetEvents, sendDraft],
  );

  const onPayload = useCallback(
    (payload: PcPayload) => {
      if (payload.type === "active_turns_changed") {
        setActiveTurns(payload.active_turns);
        return;
      }
      if (payload.type !== "agent_event") return;
      if (payload.conversation_id === wanted.current) addEvent(payload.sequence, payload.event);
      if (payload.event.type === "turn_finished") void onTurnFinished(payload.conversation_id);
    },
    [addEvent, onTurnFinished],
  );
  const onPayloadRef = useRef(onPayload);
  onPayloadRef.current = onPayload;

  const sync = useCallback(async () => {
    try {
      const link = pendingLink.current;
      if (link?.workspace) workspaceRef.current = link.workspace;
      const data = await command<BootstrapResponse>({ type: "bootstrap" });
      applyBootstrap(data);
      if (link && data.bootstrap.conversations.some((c) => c.id === link.conversation)) want(link.conversation);
      pendingLink.current = null;
      const id = wanted.current;
      if (id && data.bootstrap.conversations.some((c) => c.id === id)) {
        resetEvents();
        await loadConversation(id, data.activeTurns.some((turn) => turn.conversationId === id));
      } else if (id) {
        want(null);
        setOpen(null);
      }
      setModels(await command<ModelsResponse>({ type: "list_models" }));
    } catch (err) {
      fail(err);
    }
  }, [applyBootstrap, command, fail, loadConversation, resetEvents, want]);

  useEffect(() => {
    const remote = new RemoteClient({
      connection: setConnection,
      payload: (payload) => onPayloadRef.current(payload),
      revoked: () => {
        setRevoked(true);
        setSession(null);
        setSynced(false);
        want(null);
        setOpen(null);
      },
    });
    client.current = remote;
    setSession(remote.session);
    void remote.start();
    if (pushSupported()) {
      void navigator.serviceWorker.ready
        .then((registration) => registration.pushManager.getSubscription())
        .then((subscription) => setPushEnabled(Boolean(subscription)))
        .catch(() => undefined);
      void fetch("/vapid-public-key", { cache: "no-store" })
        .then((response) => response.json())
        .then((body: { publicKey: string | null }) => (vapidKey.current = body.publicKey))
        .catch(() => undefined);
    }
    return () => remote.stop();
  }, []);

  // (Re)synchronise whenever the Mac becomes reachable.
  useEffect(() => {
    if (session && connection.mac) void sync();
    else setSynced(false);
  }, [session, connection.mac, sync]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const events = useMemo(
    () => [...ending.current, ...[...liveEvents.current.entries()].sort((a, b) => a[0] - b[0]).map(([, event]) => event)],
    [eventsVersion],
  );
  const busy = Boolean(open && activeTurns.some((turn) => turn.conversationId === open.id));

  const closeConversation = useCallback(() => {
    want(null);
    setOpen(null);
    resetEvents();
  }, [resetEvents, want]);

  const actions = {
    async pair(code: string) {
      await client.current!.pair(code, "iPhone");
      setRevoked(false);
      setSession(client.current!.session);
    },
    forget() {
      client.current?.forget();
      setSession(null);
      setSynced(false);
      closeConversation();
      setConversations([]);
      setWorkspaces([]);
    },
    async selectWorkspace(path: string) {
      if (path === workspaceRef.current) return;
      workspaceRef.current = path;
      closeConversation();
      try {
        applyBootstrap(await command<BootstrapResponse>({ type: "bootstrap" }));
      } catch (err) {
        fail(err);
      }
    },
    refreshList,
    async openConversation(id: string) {
      want(id);
      setOpen(null);
      resetEvents();
      try {
        await loadConversation(id, activeTurns.some((turn) => turn.conversationId === id));
      } catch (err) {
        fail(err);
      }
    },
    closeConversation,
    /** Opens the conversation of a tapped notification, in its project. */
    async openLink(workspace: string | null, id: string) {
      if (workspace) await actions.selectWorkspace(workspace);
      await actions.openConversation(id);
    },
    async createConversation(harness: "classic" | "rlm", draftText?: string) {
      try {
        const bootstrap = await command<WorkspaceBootstrap>({ type: "create_conversation", harness });
        setConversations(bootstrap.conversations);
        want(bootstrap.activeConversation.id);
        if (draftText) setInitialDraft({ id: bootstrap.activeConversation.id, text: draftText });
        resetEvents();
        setOpen(bootstrap.activeConversation);
        setModeState(modeOf(bootstrap.activeConversation));
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    async deleteConversation(id: string) {
      try {
        const bootstrap = await command<WorkspaceBootstrap>({ type: "delete_conversation", conversation_id: id });
        setConversations(bootstrap.conversations);
        if (wanted.current === id) closeConversation();
      } catch (err) {
        fail(err);
      }
    },
    /** Sends now, or right after the running turn when the agent is busy. */
    async send(draft: Draft) {
      if (!open) return false;
      if (busy) {
        setQueued((current) => ({ ...current, [open.id]: draft }));
        return true;
      }
      try {
        appendUserMessage(open.id, draft.text);
        await sendDraft(open, draft, mode);
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    unqueue() {
      if (open) setQueued(({ [open.id]: _dropped, ...rest }) => rest);
    },
    async stop() {
      if (!open) return;
      try {
        await command({ type: "cancel_turn", conversation_id: open.id });
      } catch (err) {
        fail(err);
      }
    },
    async answer(toolCallId: string, answers: string[][]) {
      if (!open) return;
      try {
        await command({ type: "answer_question", conversation_id: open.id, tool_call_id: toolCallId, answers, stop_questions: false });
      } catch (err) {
        fail(err);
      }
    },
    async dismissQuestion(toolCallId: string) {
      if (!open) return;
      try {
        await command({ type: "reject_question", conversation_id: open.id, tool_call_id: toolCallId });
      } catch (err) {
        fail(err);
      }
    },
    async setMode(next: AgentMode) {
      setModeState(next);
      if (!open || busy) return;
      try {
        const updated = await command<SavedConversation>({ type: "set_conversation_mode", conversation_id: open.id, mode: next });
        setOpen((current) => (current && current.id === updated.id ? { ...updated, history: current.history } : current));
      } catch (err) {
        fail(err);
      }
    },
    async setModel(entry: ModelEntry, thinking: PhoneThinking) {
      if (!open) return;
      try {
        const modeModelSettings = await command<SavedConversation["modeModelSettings"]>({
          type: "set_conversation_model",
          conversation_id: open.id,
          mode,
          model: { provider: entry.provider, name: entry.name },
          thinking,
        });
        setOpen((current) =>
          current && current.id === open.id ? { ...current, modeModelSettings, model: modeModelSettings[mode] ?? current.model } : current,
        );
      } catch (err) {
        fail(err);
      }
    },
    async compact() {
      if (!open) return;
      try {
        await command({ type: "compact_conversation", conversation_id: open.id, model: open.model, thinking: thinkingOf(open.model) });
        await onTurnFinished(open.id);
      } catch (err) {
        fail(err);
      }
    },
    async runPlan(plan: PlanArtifact, implement: boolean) {
      if (!open) return;
      const nextMode: AgentMode = implement ? "act" : "plan";
      setModeState(nextMode);
      const attachment: Attachment = { path: plan.absolutePath ?? plan.path, name: plan.path.split("/").pop() || "plan.md", mediaType: "text/markdown" };
      try {
        await sendDraft(open, { text: implement ? IMPLEMENT_PLAN_PROMPT : KEEP_PLANNING_PROMPT, attachments: [attachment] }, nextMode, {
          plan_control: implement ? "implementPlan" : "updatePlan",
          message_visibility: "systemReminder",
        });
      } catch (err) {
        fail(err);
      }
    },
    /** Must run straight from a tap: iOS only asks for permission during a user gesture. */
    async enablePush() {
      try {
        if (!vapidKey.current) throw new Error("Les notifications ne sont pas configurées sur le relais.");
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: fromBase64Url(vapidKey.current),
        });
        await command({ type: "subscribe_push", subscription: subscription.toJSON() });
        setPushEnabled(true);
      } catch (err) {
        fail(Notification.permission === "denied" ? new Error("Notifications refusées : autorise-les dans Réglages › Notifications › Claake.") : err);
      }
    },
    async disablePush() {
      try {
        const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
        if (subscription) {
          await command({ type: "unsubscribe_push", endpoint: subscription.endpoint }).catch(() => undefined);
          await subscription.unsubscribe();
        }
        setPushEnabled(false);
      } catch (err) {
        fail(err);
      }
    },
    updateSettings(patch: Partial<Settings>) {
      const next = { ...settings, ...patch };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      setSettings(next);
    },
    fail,
    clearError: () => setError(null),
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // The service worker forwards notification taps when the app is already running.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; workspaceId?: string | null; conversationId?: string | null } | null;
      if (data?.type === "open-conversation" && data.conversationId) {
        void actionsRef.current.openLink(data.workspaceId ?? null, data.conversationId);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  return {
    session,
    connection,
    workspaces,
    workspacePath,
    conversations,
    activeTurns,
    rlmAvailable,
    synced,
    open,
    currentId,
    initialDraft: initialDraft?.id === currentId ? initialDraft.text : "",
    events,
    mode,
    models,
    busy,
    queued: open ? (queued[open.id] ?? null) : null,
    settings,
    pushEnabled,
    revoked,
    error,
    actions,
  };
}

export type Remote = ReturnType<typeof useRemote>;
