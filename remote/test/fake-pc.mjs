#!/usr/bin/env node
// Fake Mac for the Claake Remote protocol: speaks to a relay exactly like src-tauri/src/remote.rs,
// with scripted French demo data, so the phone app can be built and tested without the desktop app.
//   node test/fake-pc.mjs [relayWsUrl]      (default ws://localhost:8787/ws)
// Env: FAKE_PC_ID (pc_fake), FAKE_PC_CODE (246810), FAKE_PC_STATE (/tmp/claake-fake-pc.json).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AAD = Buffer.from("sinew-remote-v1");
const PROTOCOL_VERSION = 1;
const DEFAULT_RELAY = "ws://localhost:8787/ws";
const b64 = (buf) => Buffer.from(buf).toString("base64");
const randomId = (prefix, n) => `${prefix}_${crypto.randomBytes(n).toString("base64url")}`;
const tokenHash = (token) => b64(crypto.createHash("sha256").update(token).digest());
const uid = (prefix) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;

/* ── crypto (same as remote.rs encrypt_json / decrypt_json / derive_pairing_key) ── */

function encryptJson(key, value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { nonce: b64(nonce), ciphertext: b64(body) };
}

function decryptJson(key, envelope) {
  const raw = Buffer.from(envelope.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function derivePairingKey(shared, pcPublic, phonePublic, code) {
  return crypto.createHash("sha256")
    .update("sinew-remote-pairing-v1").update(shared).update(pcPublic).update(phonePublic).update(code)
    .digest();
}

/* ── demo data ── */

const A = (...parts) => ({ role: "assistant", parts });
const U = (...parts) => ({ role: "user", parts });
const text = (t) => ({ type: "text", text: t });
const thinking = (t) => ({ type: "thinking", text: t });
const call = (id, name, input) => ({ type: "tool_call", id, name, input });
const result = (id, content, meta = null) => ({ type: "tool_result", tool_call_id: id, content, is_error: false, meta });
const diffLines = (...lines) => lines.map(([kind, t]) => ({ kind, text: t }));
const fileChange = (relativePath, kind, summary, lines) => ({
  relativePath, kind, summary, binary: false,
  addedLines: lines.filter((l) => l.kind === "added").length,
  removedLines: lines.filter((l) => l.kind === "removed").length,
  truncated: false, lines,
});

const CARET_DIFF = fileChange("src/components/chat/Composer.tsx", "modified", "Modified Composer.tsx", diffLines(
  ["context", "  const mirror = useRef<HTMLDivElement>(null);"],
  ["removed", "  const caretStyle = { fontSize: 14, lineHeight: 1.4 };"],
  ["added", "  const caretStyle = useTextareaMetrics(textareaRef);"],
  ["added", "  // le calque doit reprendre exactement la police et le padding du textarea"],
  ["context", "  return <div ref={mirror} style={caretStyle} />;"],
));

const CARET_ANSWER = [
  "## Correctif du caret",
  "",
  "Le calque du caret n'utilisait pas les mêmes métriques que le `textarea`. J'ai corrigé trois points :",
  "",
  "- la **police** et le `line-height` sont maintenant lus depuis le style calculé ;",
  "- le `padding` du textarea est répercuté sur le calque ;",
  "- le calque est recalculé à chaque `input` et au redimensionnement.",
  "",
  "```tsx",
  "const metrics = useTextareaMetrics(textareaRef);",
  "return <div className=\"caret-mirror\" style={metrics} aria-hidden />;",
  "```",
  "",
  "| Fichier | Changement | Lignes |",
  "| --- | --- | --- |",
  "| `Composer.tsx` | métriques lues depuis le DOM | +4 −1 |",
  "| `useTextareaMetrics.ts` | nouveau hook | +22 |",
  "",
  "Les tests passent (`42 passed`).",
  "",
  "<spoken>J'ai corrigé le décalage du caret dans le composer. Le calque reprend désormais la police et le padding du champ de texte. Les quarante-deux tests passent.</spoken>",
].join("\n");

function seedConversations(workspaceId, now) {
  const model = { provider: "anthropic", name: "claude-opus-5", effort: "medium", use1mContext: null };
  const modeModelSettings = { act: model, ask: model, plan: { ...model, effort: "high" }, goal: model };
  const make = (title, harness, hoursAgo, history) => ({
    id: uid("conv"), workspaceId, title, harness, model, modeModelSettings,
    systemPrompt: "Tu es Claake Code, un agent de programmation qui travaille dans le dossier du projet.",
    planWorkflow: { status: "idle" }, goalWorkflow: { status: "idle" },
    history, updatedAtMs: now - hoursAgo * 3_600_000, seq: 0,
  });
  if (workspaceId.endsWith("ClaakeCode")) {
    return [
      make("Corriger le caret du composer", "classic", 0.2, [
        U(text("Le caret du composer est décalé quand je tape un texte long. Tu peux regarder ?")),
        A(thinking("Le décalage vient sans doute du calque miroir. Je lis d'abord le composant."),
          text("Je commence par lire le composant."),
          call("toolu_read1", "read_file", { path: "src/components/chat/Composer.tsx" })),
        U(result("toolu_read1", "export function Composer() {\n  const mirror = useRef<HTMLDivElement>(null);\n  const caretStyle = { fontSize: 14, lineHeight: 1.4 };\n  ...\n}")),
        A(text("Le style du calque est codé en dur. Je le remplace."),
          call("toolu_edit1", "edit", { path: "src/components/chat/Composer.tsx", old_string: "{ fontSize: 14, lineHeight: 1.4 }", new_string: "useTextareaMetrics(textareaRef)" })),
        U(result("toolu_edit1", "Edited src/components/chat/Composer.tsx", { file_changes: [CARET_DIFF] })),
        A(call("toolu_bash1", "bash", { command: "npm test -- composer", description: "Lancer les tests du composer" })),
        U(result("toolu_bash1", "> vitest run composer\n\n ✓ Composer.test.tsx (6)\n ✓ caret.test.tsx (4)\n\n Test Files  2 passed (2)\n      Tests  42 passed (42)\n   Duration  1.8s")),
        A(call("toolu_grep1", "grep", { pattern: "caretStyle", path: "src" })),
        U(result("toolu_grep1", "src/components/chat/Composer.tsx:41:  const caretStyle = useTextareaMetrics(textareaRef);\nsrc/components/chat/Composer.tsx:88:  return <div ref={mirror} style={caretStyle} />;")),
        A(text(CARET_ANSWER)),
      ]),
      make("Ajouter la sauvegarde automatique", "classic", 3, [
        U(text("Ajoute une sauvegarde automatique des brouillons toutes les 5 secondes.")),
        A(thinking("Je vérifie s'il existe déjà un hook de debounce."), call("toolu_grep2", "grep", { pattern: "useDebounce", path: "src" })),
        U(result("toolu_grep2", "src/hooks/useDebounce.ts:3:export function useDebounce<T>(value: T, delay: number) {")),
        A(text("Le hook `useDebounce` existe déjà. Je peux l'utiliser pour enregistrer le brouillon dans le stockage local.")),
      ]),
      make("Pourquoi le build Rust échoue ?", "classic", 26, [
        U(text("cargo build échoue chez moi, tu vois pourquoi ?")),
        A(call("toolu_bash3", "bash", { command: "cargo build 2>&1 | tail -n 8" })),
        U(result("toolu_bash3", "error[E0432]: unresolved import `claakecode_core::catalog`\n --> src-tauri/src/providers.rs:12:5\n  |\n12 | use claakecode_core::catalog;\n  |     ^^^^^^^^^^^^^^^^^^^^^^^^ no `catalog` in the root")),
        A(text("L'import `catalog` est introuvable : le module n'est pas exporté dans `lib.rs`. Ajoute `pub mod catalog;` dans `crates/claakecode-core/src/lib.rs`.")),
      ]),
      make("Refonte du pipeline de release", "rlm", 30, [
        U(text("Prépare un plan pour accélérer le pipeline de release.")),
        A(thinking("Je cherche d'abord les workflows existants."), call("toolu_grep4", "grep", { pattern: "runs-on", path: ".github/workflows" })),
        U(result("toolu_grep4", ".github/workflows/release.yml:12:    runs-on: macos-14\n.github/workflows/release.yml:48:    runs-on: windows-latest")),
        A(text("## Pistes\n\n1. Mettre en cache `target/` entre les jobs.\n2. Construire macOS et Windows en parallèle.\n3. Signer les binaires dans un job séparé.")),
      ]),
      make("Idées de nom pour la v2", "classic", 80, [
        U(text("Donne-moi 3 idées de nom pour la v2.")),
        A(text("Voici trois idées :\n\n- **Claake Studio**\n- **Claake Forge**\n- **Claake Atelier**")),
      ]),
    ];
  }
  return [
    make("Page tarifs : responsive mobile", "classic", 1.5, [
      U(text("La grille des tarifs déborde sur mobile.")),
      A(call("toolu_edit6", "edit", { path: "src/pages/pricing.css", old_string: "grid-template-columns: repeat(3, 1fr);", new_string: "grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));" })),
      U(result("toolu_edit6", "Edited src/pages/pricing.css", { file_changes: [fileChange("src/pages/pricing.css", "modified", "Modified pricing.css", diffLines(
        ["removed", "  grid-template-columns: repeat(3, 1fr);"],
        ["added", "  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));"]))] })),
      A(text("La grille passe maintenant à une seule colonne sous 520 px.")),
    ]),
    make("Audit SEO de la home", "rlm", 12, [
      U(text("Fais un audit SEO rapide de la page d'accueil.")),
      A(call("toolu_grep7", "grep", { pattern: "<title>|<meta name=\"description\"", path: "index.html" })),
      U(result("toolu_grep7", "index.html:5:  <title>Site</title>")),
      A(text("## Audit\n\n| Point | État |\n| --- | --- |\n| Balise `title` | trop courte |\n| Meta `description` | absente |\n| Balise `h1` | présente |\n\nJe propose d'ajouter une description de 150 caractères.")),
    ]),
  ];
}

function seedWorkspaces(now) {
  return new Map([["/Users/demo/ClaakeCode", "ClaakeCode"], ["/Users/demo/site", "site"]].map(([p, name]) => [
    p, { path: p, name, conversations: new Map(seedConversations(p, now).map((c) => [c.id, c])) },
  ]));
}

function loadCatalog() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../models.json");
  const models = JSON.parse(fs.readFileSync(file, "utf8")).models;
  return models.map((m) => ({
    supportsFast: false, supportsImages: true, contextWindow1m: null, preferredWindow1m: null, hidden: false, ...m,
  }));
}

/* ── scripted turn text ── */

const summary = (c) => ({ id: c.id, title: c.title, updatedAtMs: c.updatedAtMs, harness: c.harness });
const saved = ({ seq, updatedAtMs, ...rest }) => rest;
const CANCELLED = Symbol("cancelled");

/* ── fake Mac ── */

export function startFakePc({
  relayUrl = DEFAULT_RELAY,
  pcId = "pc_fake",
  code = "246810",
  statePath = "/tmp/claake-fake-pc.json",
  log = console.log,
  speed = 1,
} = {}) {
  const store = (() => {
    try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { devices: [] }; }
  })();
  const save = () => fs.writeFileSync(statePath, JSON.stringify(store, null, 2));
  const workspaces = seedWorkspaces(Date.now());
  const catalog = loadCatalog();
  const turns = new Map(); // conversationId -> active turn
  const seenRequests = new Set();
  const pairing = { code, expiresAtMs: 0 };
  let ws = null;
  let closed = false;
  let backoff = 1000;
  let timers = [];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms * speed));
  const send = (frame) => ws?.readyState === 1 && ws.send(JSON.stringify(frame));
  const deviceKey = (device) => Buffer.from(device.secretB64, "base64");
  const activeDevices = () => store.devices.filter((d) => !d.revokedAtMs);
  const sendTo = (device, payload) => send({ kind: "pc_cipher", device_id: device.id, envelope: encryptJson(deviceKey(device), payload) });
  const broadcast = (payload) => activeDevices().forEach((d) => sendTo(d, payload));

  function sendPairingCode() {
    pairing.expiresAtMs = Date.now() + 3_600_000;
    send({ kind: "pc_pairing_code", pc_id: pcId, code: pairing.code, expires_at_ms: pairing.expiresAtMs });
  }

  function connect() {
    if (closed) return;
    const socket = new WebSocket(relayUrl);
    ws = socket;
    socket.addEventListener("open", () => {
      backoff = 1000;
      send({ kind: "pc_hello", pc_id: pcId, protocol_version: PROTOCOL_VERSION });
      sendPairingCode();
      log(`[fake-pc] connected to ${relayUrl} as ${pcId}`);
    });
    socket.addEventListener("message", (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      handleFrame(frame).catch((err) => log(`[fake-pc] frame error: ${err.message}`));
    });
    socket.addEventListener("close", () => {
      if (ws === socket) ws = null;
      if (closed) return;
      log(`[fake-pc] relay dropped, retrying in ${backoff} ms`);
      timers.push(setTimeout(connect, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    });
    socket.addEventListener("error", () => {});
  }

  async function handleFrame(frame) {
    switch (frame.kind) {
      case "pairing_request": return handlePairingRequest(frame);
      case "phone_cipher": return handlePhoneCipher(frame);
      default: return; // pong, pc_registered, phone_connected, phone_disconnected, error
    }
  }

  /* pairing — remote.rs handle_pairing_request */

  function handlePairingRequest({ phone_conn_id, code: phoneCode, device_name, phone_public_key }) {
    const reject = (error) => send({ kind: "pc_pair_response", phone_conn_id, accepted: false, pc_public_key: null, encrypted: null, error });
    if (phoneCode !== pairing.code || pairing.expiresAtMs <= Date.now()) return reject("invalid pairing code");
    const phonePublic = Buffer.from(phone_public_key, "base64");
    const ecdh = crypto.createECDH("prime256v1");
    const pcPublic = ecdh.generateKeys();
    const pairingKey = derivePairingKey(ecdh.computeSecret(phonePublic), pcPublic, phonePublic, phoneCode);
    const secret = crypto.randomBytes(32);
    const deviceToken = randomId("tok", 32);
    const grant = {
      pcId,
      relayUrl: publicRelayUrl(relayUrl),
      deviceId: randomId("dev", 18),
      deviceName: String(device_name || "").trim().slice(0, 80) || "Phone",
      deviceToken,
      deviceSecret: b64(secret),
    };
    store.devices.push({
      id: grant.deviceId, name: grant.deviceName, tokenHash: tokenHash(deviceToken), secretB64: grant.deviceSecret,
      pairedAtMs: Date.now(), lastSeenAtMs: null, revokedAtMs: null, pushSubscriptions: [],
    });
    save();
    send({ kind: "pc_pair_response", phone_conn_id, accepted: true, pc_public_key: b64(pcPublic), encrypted: encryptJson(pairingKey, grant), error: null });
    log(`[fake-pc] paired "${grant.deviceName}" (${grant.deviceId})`);
  }

  /* commands — remote.rs handle_phone_cipher / execute_phone_command */

  async function handlePhoneCipher({ device_id, envelope }) {
    const device = activeDevices().find((d) => d.id === device_id);
    if (!device) return;
    let requestId = null;
    try {
      const cmd = decryptJson(deviceKey(device), envelope);
      if (tokenHash(cmd.token) !== device.tokenHash) throw new Error("remote device token rejected");
      device.lastSeenAtMs = Date.now();
      const dedupe = `${device_id}:${cmd.requestId}`;
      if (seenRequests.has(dedupe)) throw new Error("duplicate remote request rejected");
      seenRequests.add(dedupe);
      requestId = cmd.requestId;
      const data = await execute(device, cmd);
      sendTo(device, { type: "response", request_id: requestId, ok: true, data, error: null });
    } catch (err) {
      sendTo(device, { type: "response", request_id: requestId ?? "unknown", ok: false, data: null, error: err.message });
    }
  }

  function workspaceFor(requested) {
    if (requested) {
      const found = workspaces.get(requested);
      if (!found) throw new Error("this workspace is no longer open on the PC");
      return found;
    }
    return workspaces.values().next().value;
  }

  function conversationIn(workspace, id) {
    const conv = workspace.conversations.get(id);
    if (!conv) throw new Error(`conversation not found: ${id}`);
    return conv;
  }

  const sortedSummaries = (workspace) =>
    [...workspace.conversations.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs).map(summary);

  function bootstrapOf(workspace, preferredId) {
    const conversations = sortedSummaries(workspace);
    const active = [...turns.values()].filter((t) => t.workspaceId === workspace.path).sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    const activeId = preferredId ?? active?.conversationId ?? conversations[0]?.id;
    const conv = workspace.conversations.get(activeId) ?? createConversation(workspace, "classic");
    return {
      workspace: { path: workspace.path, name: workspace.name },
      conversations: sortedSummaries(workspace),
      activeConversation: saved(conv),
      modeModelSettings: conv.modeModelSettings,
    };
  }

  function createConversation(workspace, harness) {
    const model = { provider: "anthropic", name: "claude-opus-5", effort: "medium", use1mContext: null };
    const conv = {
      id: uid("conv"), workspaceId: workspace.path, title: "Nouvelle conversation", harness,
      model, modeModelSettings: { act: model, ask: model, plan: model, goal: model },
      systemPrompt: "Tu es Claake Code, un agent de programmation qui travaille dans le dossier du projet.",
      planWorkflow: { status: "idle" }, goalWorkflow: { status: "idle" }, history: [], updatedAtMs: Date.now(), seq: 0,
    };
    workspace.conversations.set(conv.id, conv);
    return conv;
  }

  const activeTurnSummaries = () => [...turns.values()]
    .map((t) => ({ workspaceId: t.workspaceId, conversationId: t.conversationId, startedAtMs: t.startedAtMs, latestSequence: t.conv.seq }))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || b.startedAtMs - a.startedAtMs);
  const broadcastActiveTurns = () => broadcast({ type: "active_turns_changed", active_turns: activeTurnSummaries() });

  async function execute(device, { workspace: requested, command }) {
    const workspace = workspaceFor(requested);
    switch (command.type) {
      case "bootstrap":
        return {
          workspacePath: workspace.path,
          workspaces: [...workspaces.values()].map((w) => ({ path: w.path, name: w.name })),
          bootstrap: bootstrapOf(workspace),
          activeTurns: activeTurnSummaries(),
          rlmAvailable: true,
        };
      case "list_conversations":
        return sortedSummaries(workspace);
      case "create_conversation": {
        const conv = createConversation(workspace, command.harness === "rlm" ? "rlm" : "classic");
        return bootstrapOf(workspace, conv.id);
      }
      case "load_conversation":
        return saved(conversationIn(workspace, command.conversation_id));
      case "delete_conversation": {
        conversationIn(workspace, command.conversation_id);
        workspace.conversations.delete(command.conversation_id);
        return bootstrapOf(workspace);
      }
      case "set_conversation_mode": {
        const conv = conversationIn(workspace, command.conversation_id);
        const now = Date.now();
        conv.planWorkflow = command.mode === "plan" ? { status: "planningQuestions" } : { status: "idle" };
        conv.goalWorkflow = command.mode === "goal"
          ? { status: "active", objective: "Objectif en cours", startedAtMs: now, updatedAtMs: now }
          : { status: "idle" };
        return saved(conv);
      }
      case "list_models":
        return { providers: ["anthropic", "openai"], openrouterModels: [], modelCatalog: catalog };
      case "set_conversation_model": {
        const conv = conversationIn(workspace, command.conversation_id);
        const current = conv.modeModelSettings[command.mode];
        const next = command.model
          ? { provider: command.model.provider, name: command.model.name, effort: current.effort, use1mContext: command.model.use1mContext ?? null }
          : { ...current };
        if (command.thinking) next.effort = command.thinking === "off" ? "none" : command.thinking;
        conv.modeModelSettings = { ...conv.modeModelSettings, [command.mode]: next };
        conv.model = conv.modeModelSettings.act;
        return conv.modeModelSettings;
      }
      case "send_message": {
        const conv = conversationIn(workspace, command.conversation_id);
        if (turns.has(conv.id)) throw new Error("this conversation already has an active turn");
        startTurn(workspace, conv, command);
        return { accepted: true };
      }
      case "compact_conversation": {
        const conv = conversationIn(workspace, command.conversation_id);
        conv.history = [A(text("Résumé de la conversation : " + conv.title + ". Les échanges précédents ont été compactés."))];
        return { compacted: true };
      }
      case "answer_question":
      case "reject_question": {
        const turn = turns.get(command.conversation_id);
        const waiting = turn?.question?.toolCallId === command.tool_call_id ? turn.question : null;
        waiting?.resolve(command.type === "answer_question"
          ? { answers: command.answers ?? [], stop: Boolean(command.stop_questions) }
          : { rejected: true });
        return { accepted: Boolean(waiting) };
      }
      case "cancel_turn": {
        const turn = turns.get(command.conversation_id);
        if (turn) { turn.cancelled = true; turn.question?.resolve({ cancelled: true }); }
        return { cancelled: Boolean(turn) };
      }
      case "replay_active_turn_events": {
        const turn = turns.get(command.conversation_id);
        const after = command.after_sequence ?? 0;
        if (!turn || turn.workspaceId !== workspace.path) {
          return { active: false, workspaceId: workspace.path, conversationId: command.conversation_id, startedAtMs: null, latestSequence: 0, events: [] };
        }
        return {
          active: true, workspaceId: turn.workspaceId, conversationId: turn.conversationId, startedAtMs: turn.startedAtMs,
          latestSequence: turn.conv.seq, events: turn.events.filter((e) => e.sequence > after),
        };
      }
      case "subscribe_push": {
        device.pushSubscriptions = device.pushSubscriptions.filter((s) => s.endpoint !== command.subscription.endpoint);
        device.pushSubscriptions.push(command.subscription);
        save();
        return { subscribed: true };
      }
      case "unsubscribe_push": {
        device.pushSubscriptions = device.pushSubscriptions.filter((s) => s.endpoint !== command.endpoint);
        save();
        return { subscribed: false };
      }
      case "ping":
        return { pong: true, nowMs: Date.now() };
      default:
        throw new Error(`unknown command: ${command.type}`);
    }
  }

  /* turns */

  function startTurn(workspace, conv, { text: userText, attachments = [], voice = false }) {
    const turn = {
      workspaceId: workspace.path, conversationId: conv.id, conv, startedAtMs: Date.now(),
      events: [], cancelled: false, question: null, parts: [], messages: [],
    };
    turns.set(conv.id, turn);
    conv.history.push(U(text(userText)));
    if (conv.title === "Nouvelle conversation") conv.title = userText.trim().slice(0, 60) || conv.title;
    conv.updatedAtMs = Date.now();
    runTurn(turn, userText, { voice, attachments: attachments.length }).catch((err) => log(`[fake-pc] turn error: ${err.stack}`));
  }

  function emit(turn, event) {
    const sequence = ++turn.conv.seq;
    turn.events.push({ sequence, event });
    broadcast({ type: "agent_event", workspace_id: turn.workspaceId, conversation_id: turn.conversationId, sequence, event });
  }

  async function tick(turn, ms) {
    await sleep(ms);
    if (turn.cancelled) throw CANCELLED;
  }

  async function streamText(turn, body, delay = 30) {
    emit(turn, { type: "text_started" });
    for (let i = 0; i < body.length; i += 14) {
      emit(turn, { type: "text_chunk", delta: body.slice(i, i + 14) });
      await tick(turn, delay);
    }
    emit(turn, { type: "text_finished" });
    turn.parts.push(text(body));
  }

  async function streamThinking(turn, body) {
    emit(turn, { type: "thinking_started" });
    for (let i = 0; i < body.length; i += 24) {
      emit(turn, { type: "thinking_chunk", delta: body.slice(i, i + 24) });
      await tick(turn, 30);
    }
    emit(turn, { type: "thinking_finished" });
    turn.parts.push(thinking(body));
  }

  // run() returns {output, fileChanges?, meta?, isError?}; output is streamed as deltas unless deltas is false.
  async function runTool(turn, name, input, summaryText, run, { deltas = true } = {}) {
    const id = uid("toolu");
    emit(turn, { type: "tool_started", id, name });
    const args = JSON.stringify(input);
    for (let i = 0; i < args.length; i += 20) {
      emit(turn, { type: "tool_args_delta", id, delta: args.slice(i, i + 20) });
      await tick(turn, 30);
    }
    emit(turn, { type: "tool_ready", id, summary: summaryText, args_pretty: JSON.stringify(input, null, 2) });
    const { output, fileChanges = [], meta = null, isError = false } = await run(id);
    if (deltas) {
      for (const line of output.split("\n")) {
        emit(turn, { type: "tool_output_delta", id, delta: line + "\n" });
        await tick(turn, 40);
      }
    }
    const resultMeta = fileChanges.length ? { ...meta, file_changes: fileChanges } : meta;
    emit(turn, { type: "tool_finished", id, output, is_error: isError, file_changes: fileChanges, images: [], ...(meta ? { meta } : {}) });
    turn.messages.push(A(...turn.parts, call(id, name, input)), U({ ...result(id, output, resultMeta), is_error: isError }));
    turn.parts = [];
  }

  function waitForAnswer(turn, toolCallId) {
    return new Promise((resolve) => {
      turn.question = { toolCallId, resolve: (value) => { turn.question = null; resolve(value); } };
    });
  }

  async function runTurn(turn, userText, { voice, attachments }) {
    broadcastActiveTurns();
    emit(turn, { type: "turn_started" });
    const lower = userText.toLowerCase();
    const topic = userText.trim().replace(/\s+/g, " ").slice(0, 60);
    try {
      await tick(turn, 150);
      await streamThinking(turn, `L'utilisateur demande : « ${topic} ». Je commence par lire le code concerné avant de modifier quoi que ce soit.`);
      await streamText(turn, attachments ? `Je regarde ta demande et ${attachments} pièce(s) jointe(s).` : "Je regarde le code concerné.");
      if (lower.includes("erreur")) {
        await tick(turn, 200);
        emit(turn, { type: "error", message: "Le fournisseur de modèle a renvoyé une erreur (503 Service Unavailable)." });
        return;
      }
      await runTool(turn, "read_file", { path: "src/lib/session.ts" }, "Lecture de src/lib/session.ts", async () => ({
        output: "export function openSession(id: string) {\n  return sessions.get(id);\n}\n",
      }));
      let answerLine = "";
      if (lower.includes("question")) {
        const input = { questions: [{
          question: "Quelle approche préfères-tu ?",
          header: "Approche",
          options: [
            { label: "Correctif minimal", description: "Modifier uniquement la fonction concernée." },
            { label: "Refactorisation", description: "Extraire un module et ajouter des tests." },
          ],
          multiSelect: false,
        }] };
        await runTool(turn, "question", input, "Question", async (id) => {
          const reply = await waitForAnswer(turn, id);
          if (reply.cancelled) throw CANCELLED;
          if (reply.rejected) return { output: "L'utilisateur a refusé de répondre.", isError: true };
          answerLine = reply.answers.map((a) => a.join(", ")).filter(Boolean).join(" ; ");
          return { output: `Réponse : ${answerLine}`, meta: { question_answers: reply.answers } };
        }, { deltas: false });
        await streamText(turn, answerLine ? `D'accord, je pars sur : ${answerLine}.` : "D'accord, je continue sans ta réponse.");
      }
      await runTool(turn, "edit", { path: "src/lib/session.ts", old_string: "return sessions.get(id);", new_string: "return sessions.get(id) ?? null;" }, "Modification de src/lib/session.ts", async () => ({
        output: "Edited src/lib/session.ts",
        fileChanges: [fileChange("src/lib/session.ts", "modified", "Modified session.ts", diffLines(
          ["context", "export function openSession(id: string) {"],
          ["removed", "  return sessions.get(id);"],
          ["added", "  return sessions.get(id) ?? null;"],
          ["context", "}"]))],
      }), { deltas: false });
      await runTool(turn, "bash", { command: "npm test", description: "Lancer les tests" }, "npm test", async () => ({
        output: "> vitest run\n\n ✓ session.test.ts (3)\n ✓ store.test.ts (5)\n\n Tests  8 passed (8)\n Duration  1.2s",
      }));
      await runTool(turn, "grep", { pattern: "openSession", path: "src" }, "Recherche de openSession", async () => ({
        output: "src/lib/session.ts:1:export function openSession(id: string) {\nsrc/app.ts:14:  const s = openSession(route.id);",
      }));
      let finalText = "## Terminé\n\nJ'ai modifié `openSession` pour renvoyer `null` quand la session n'existe pas :\n\n```ts\nreturn sessions.get(id) ?? null;\n```\n\n- les tests passent (`8 passed`) ;\n- les deux appels existants gèrent déjà `null`.";
      if (voice) finalText += "\n\n<spoken>J'ai corrigé la fonction qui ouvre une session. Elle renvoie maintenant null quand la session n'existe pas. Les huit tests passent.</spoken>";
      await streamText(turn, finalText);
    } catch (err) {
      if (err !== CANCELLED) throw err;
      emit(turn, { type: "interrupted" });
    } finally {
      finishTurn(turn);
    }
  }

  function finishTurn(turn) {
    const { conv } = turn;
    if (turn.parts.length) turn.messages.push(A(...turn.parts));
    conv.history.push(...turn.messages);
    conv.updatedAtMs = Date.now();
    emit(turn, { type: "turn_finished", duration_ms: Date.now() - turn.startedAtMs });
    turns.delete(conv.id);
    broadcastActiveTurns();
    const subscriptions = new Map(activeDevices().flatMap((d) => d.pushSubscriptions).map((s) => [s.endpoint, s]));
    for (const subscription of subscriptions.values()) {
      send({ kind: "pc_push", subscription, payload: { title: conv.title || "Claake Code", body: "L'agent a terminé.", workspaceId: conv.workspaceId, conversationId: conv.id } });
    }
  }

  /* lifecycle */

  timers.push(setInterval(() => send({ kind: "ping" }), 25_000));
  timers.push(setInterval(sendPairingCode, 5 * 60_000));
  connect();

  return {
    code: pairing.code,
    pairingUrl: `${publicRelayUrl(relayUrl)}/?code=${pairing.code}`,
    close() {
      closed = true;
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      for (const turn of turns.values()) turn.cancelled = true;
      ws?.close();
    },
  };
}

function publicRelayUrl(wsUrl) {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/ws$/, "").replace(/\/$/, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relayUrl = process.argv[2] || DEFAULT_RELAY;
  const pc = startFakePc({
    relayUrl,
    pcId: process.env.FAKE_PC_ID || "pc_fake",
    code: process.env.FAKE_PC_CODE || "246810",
    statePath: process.env.FAKE_PC_STATE || "/tmp/claake-fake-pc.json",
  });
  console.log(`[fake-pc] pairing code: ${pc.code}`);
  console.log(`[fake-pc] pairing URL:  ${pc.pairingUrl}`);
  process.on("SIGINT", () => { pc.close(); process.exit(0); });
}
