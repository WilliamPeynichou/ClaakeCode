/**
 * In-page fake of the Tauri backend for browser e2e runs. Injected before the app loads, it
 * implements `window.__TAURI_INTERNALS__` (invoke + callbacks + event plugin) with just enough
 * state to drive the RLM chat. Every invoke is recorded in `window.__mock.calls`.
 *
 * This tests the frontend contract, not Prime: the backend side is covered by the Rust tests
 * against the real `prime-agent` binary.
 */
export type MockOptions = {
  /** When true, create_rlm_conversation fails like a non-git workspace. */
  rlmCreateFails?: boolean;
};

export function installTauriMock(options: MockOptions) {
  const WS = "/tmp/e2e-workspace";
  const model = { provider: "anthropic", name: "claude-sonnet-4-5" };
  const modes = { act: model, ask: model, plan: model, goal: model };
  const now = Date.now();
  const conv = (id: string, title: string, harness: "classic" | "rlm") => ({
    summary: { id, title, updatedAtMs: now, harness },
    saved: {
      id,
      workspaceId: WS,
      title,
      model,
      modeModelSettings: modes,
      systemPrompt: "",
      planWorkflow: { status: "idle" },
      goalWorkflow: { status: "idle" },
      history: [] as Array<{ role: string; parts: Array<{ type: string; text: string }> }>,
    },
  });
  const conversations = [conv("c-classic", "Classic chat", "classic")];
  const bindings: Record<string, { worktreePath: string; sessionPath: string | null }> = {};
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners = new Map<string, number[]>();
  let nextId = 1;
  const calls: Array<{ cmd: string; args: any }> = [];

  const bootstrap = (activeId: string) => ({
    workspace: { path: WS, name: "e2e-workspace" },
    conversations: conversations.map((c) => c.summary),
    activeConversation: conversations.find((c) => c.summary.id === activeId)!.saved,
    modeModelSettings: modes,
  });

  const emit = (event: string, payload: unknown) => {
    for (const id of listeners.get(event) ?? []) {
      callbacks.get(id)?.({ event, id, payload });
    }
  };

  let sequence = 0;
  const agentEvent = (conversationId: string, event: Record<string, unknown>) =>
    emit("agent-event", { workspaceId: WS, conversationId, sequence: ++sequence, event });

  const handlers: Record<string, (args: any) => unknown> = {
    check_for_update: () => ({ available: false }),
    updater_check: () => ({ available: false }),
    list_active_turns: () => [],
    list_configured_model_providers: () => ["anthropic"],
    list_installed_skills_command: () => [],
    list_mistral_models: () => [],
    list_openrouter_models: () => [],
    list_workspace_entries_command: () => [],
    watch_workspace_command: () => null,
    unwatch_workspace_command: () => null,
    open_workspace: () => bootstrap("c-classic"),
    list_conversations: () => conversations.map((c) => c.summary),
    load_conversation: ({ input }) =>
      conversations.find((c) => c.summary.id === input.conversationId)?.saved ?? null,
    create_rlm_conversation: () => {
      if (options.rlmCreateFails) {
        throw "RLM chat needs a git repository: it works in an isolated worktree";
      }
      const id = `c-rlm-${conversations.length}`;
      conversations.unshift(conv(id, "New RLM chat", "rlm"));
      bindings[id] = { worktreePath: `/tmp/e2e-workspace-claakecode-rlm-${id}`, sessionPath: null };
      return bootstrap(id);
    },
    get_rlm_binding: ({ input }) => bindings[input.conversationId] ?? null,
    send_rlm_message: async ({ input }) => {
      const c = conversations.find((x) => x.summary.id === input.conversationId)!;
      c.saved.history.push({ role: "user", parts: [{ type: "text", text: input.text }] });
      const reply = `RLM reply to: ${input.text}`;
      agentEvent(input.conversationId, { type: "turn_started" });
      agentEvent(input.conversationId, { type: "text_started" });
      for (const word of reply.split(" ")) {
        await new Promise((r) => setTimeout(r, 20));
        agentEvent(input.conversationId, { type: "text_chunk", delta: `${word} ` });
      }
      agentEvent(input.conversationId, { type: "text_finished" });
      agentEvent(input.conversationId, { type: "turn_finished", duration_ms: 120 });
      c.saved.history.push({ role: "assistant", parts: [{ type: "text", text: reply }] });
      return null;
    },
    stop_rlm_turn: () => null,
    get_python_runtime_status: () => ({
      env: {
        venvPath: "/data/claakecode/prime/kernel-venv",
        installed: true,
        pythonVersion: "3.12.4",
        packages: [
          { name: "numpy", version: "2.1.0" },
          { name: "pandas", version: "2.2.3" },
        ],
        sizeBytes: 52428800,
      },
      running: true,
      activeSessions: 1,
      connectedProviders: ["anthropic", "openrouter"],
    }),
    restart_python_runtime: () => null,
    "plugin:event|listen": ({ event, handler }) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return handler;
    },
    "plugin:event|unlisten": () => null,
  };

  (window as any).__mock = { calls };
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  (window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb: (p: unknown) => void) {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc: (path: string) => path,
    async invoke(cmd: string, args: any) {
      calls.push({ cmd, args });
      const handler = handlers[cmd];
      // Unknown commands resolve to null: the app treats them as "nothing configured".
      if (!handler) console.error(`[mock] unhandled ${cmd}`);
      return handler ? handler(args ?? {}) : null;
    },
  };
  localStorage.setItem("claakecode.lastWorkspace", WS);
}
