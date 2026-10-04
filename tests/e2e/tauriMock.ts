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
  /** Seeds an existing RLM conversation with history, as after an app restart. */
  seedRlm?: boolean;
  /** Gives the classic chat a short history, so Auto Compute has something to hand over. */
  seedClassic?: boolean;
};

export function installTauriMock(options: MockOptions) {
  const WS = "/tmp/e2e-workspace";
  const model = { provider: "anthropic", name: "claude-sonnet-5" };
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
  if (options.seedClassic) {
    conversations[0].saved.history.push(
      { role: "user", parts: [{ type: "text", text: "quelle est la latence médiane ?" }] },
      { role: "assistant", parts: [{ type: "text", text: "Il faut charger runs.csv pour la calculer." }] },
    );
  }
  const bindings: Record<string, { worktreePath: string; sessionPath: string | null }> = {};
  if (options.seedRlm) {
    const seeded = conv("c-rlm-old", "Old RLM chat", "rlm");
    seeded.saved.history.push(
      { role: "user", parts: [{ type: "text", text: "question d'hier" }] },
      { role: "assistant", parts: [{ type: "text", text: "réponse persistée d'hier" }] },
    );
    conversations.push(seeded);
    bindings["c-rlm-old"] = { worktreePath: "/tmp/e2e-workspace-claakecode-rlm-old", sessionPath: "/data/s.jsonl" };
  }
  const memories = [
    { id: "m-median", kind: "memory", title: "Median latency", content: "Use p50 on runs.csv, not the mean.", path: "general",
      scope: "global", scopeLabel: "Global", source: "agent", createdAt: "2026-10-03T10:00:00.000Z", updatedAt: "2026-10-03T10:00:00.000Z", version: 1 },
    { id: "m-csv", kind: "memory", title: "runs.csv encoding", content: "File is latin-1.", path: "general",
      scope: "c-rlm-old", scopeLabel: "Old RLM chat", source: "agent", createdAt: "2026-10-02T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z", version: 1 },
  ];
  let claakyOn = true;
  let stopRequested = false;
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
    rename_conversation: ({ input }) => {
      const c = conversations.find((x) => x.summary.id === input.conversationId);
      if (c) {
        c.summary.title = input.title;
        c.saved.title = input.title;
      }
      return conversations.map((x) => x.summary);
    },
    set_conversation_model_preference: ({ input }) => {
      const c = conversations.find((x) => x.summary.id === input.conversationId);
      if (c) c.saved.modeModelSettings = { ...c.saved.modeModelSettings, [input.mode]: input.model };
      return c?.saved.modeModelSettings ?? modes;
    },
    delete_conversation: ({ input }) => {
      const i = conversations.findIndex((x) => x.summary.id === input.conversationId);
      if (i >= 0) conversations.splice(i, 1);
      return bootstrap("c-classic");
    },
    get_rlm_binding: ({ input }) => bindings[input.conversationId] ?? null,
    send_rlm_message: async ({ input }) => {
      const c = conversations.find((x) => x.summary.id === input.conversationId)!;
      c.saved.history.push({ role: "user", parts: [{ type: "text", text: input.text }] });
      const reply = `RLM reply to: ${input.text}`;
      // "slow" in the prompt streams long enough for the user to press Stop.
      const words = input.text.includes("slow") ? Array.from({ length: 400 }, (_, i) => `w${i}`) : reply.split(" ");
      stopRequested = false;
      agentEvent(input.conversationId, { type: "turn_started" });
      agentEvent(input.conversationId, { type: "text_started" });
      for (const word of words) {
        await new Promise((r) => setTimeout(r, 20));
        if (stopRequested) {
          agentEvent(input.conversationId, { type: "text_finished" });
          agentEvent(input.conversationId, { type: "interrupted" });
          return null;
        }
        agentEvent(input.conversationId, { type: "text_chunk", delta: `${word} ` });
      }
      agentEvent(input.conversationId, { type: "text_finished" });
      agentEvent(input.conversationId, { type: "turn_finished", duration_ms: 120 });
      c.saved.history.push({ role: "assistant", parts: [{ type: "text", text: reply }] });
      return null;
    },
    stop_rlm_turn: () => {
      stopRequested = true;
      return null;
    },
    estimate_context: () => ({
      usedTokens: 1200, contextWindow: 200000, preferredWindow: 200000, maxOutputTokens: 8000,
      inputTokens: 1000, outputTokens: 200, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      exact: true, error: null, breakdown: [],
    }),
    get_claaky_enabled: () => claakyOn,
    set_claaky_enabled: ({ enabled }) => { claakyOn = enabled; return null; },
    list_rlm_memories: () => memories.map((m) => ({ ...m })),
    edit_rlm_memory: ({ input }) => {
      const m = memories.find((x) => x.id === input.id);
      if (m) { m.title = input.title; m.content = input.content; m.source = "user"; m.version += 1; }
      return null;
    },
    delete_rlm_memory: ({ input }) => {
      const i = memories.findIndex((x) => x.id === input.id);
      if (i >= 0) memories.splice(i, 1);
      return null;
    },
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
    get_model_stats: ({ input }) => {
      const row = (harness: string, model: string, responses: number) => ({
        harness, provider: "anthropic", model, responses, conversations: 3,
        inputTokens: responses * 1000, promptTokens: responses * 4000, outputTokens: responses * 300,
        reasoningTokens: responses * 30, cacheReadTokens: responses * 3000, cacheCreationTokens: 0,
        toolCalls: responses, toolErrors: 1,
      });
      const rows = [row("classic", "claude-sonnet-5", 42), row("classic", "claude-haiku-5", 7)]
        .filter((r) => !input?.harness || r.harness === input.harness);
      return { rows, totalResponses: rows.reduce((s, r) => s + r.responses, 0), minReliable: 20, sinceMs: null };
    },
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
