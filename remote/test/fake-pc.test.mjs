// Phone-side client against a relay (wrangler dev on port 8789, or RELAY_URL) with the fake Mac started in-process.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { startFakePc } from "./fake-pc.mjs";
import { startRelay } from "./wrangler.mjs";

let RELAY_URL;
const AAD = new TextEncoder().encode("sinew-remote-v1");
const subtle = crypto.subtle;
const toB64 = (bytes) => Buffer.from(bytes).toString("base64");
const fromB64 = (text) => new Uint8Array(Buffer.from(text, "base64"));
const text = (value) => new TextEncoder().encode(value);

async function aesKey(raw) {
  return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptJson(key, value) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const body = await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: AAD }, key, text(JSON.stringify(value)));
  return { nonce: toB64(nonce), ciphertext: toB64(new Uint8Array(body)) };
}

async function decryptJson(key, envelope) {
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(envelope.nonce), additionalData: AAD }, key, fromB64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

class Phone {
  constructor() {
    this.payloads = [];
    this.pending = new Map();
    this.frames = [];
  }

  async open() {
    this.ws = new WebSocket(RELAY_URL);
    this.ws.addEventListener("message", (event) => this.onFrame(JSON.parse(event.data)));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error(`cannot reach relay at ${RELAY_URL}`)), { once: true });
    });
  }

  close() {
    this.ws?.close();
  }

  frame(kind) {
    return this.until(() => this.frames.find((f) => f.kind === kind));
  }

  async onFrame(frame) {
    this.frames.push(frame);
    if (frame.kind !== "pc_cipher" || !this.key) return;
    const payload = await decryptJson(this.key, frame.envelope);
    if (payload.type === "response") {
      this.pending.get(payload.request_id)?.(payload);
      this.pending.delete(payload.request_id);
    } else {
      this.payloads.push(payload);
    }
  }

  async until(check, timeoutMs = 8000) {
    const start = Date.now();
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async pairRequest(code) {
    const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    this.frames.length = 0;
    this.ws.send(JSON.stringify({ kind: "phone_pair_request", code, deviceName: "Test iPhone", phonePublicKey: toB64(publicRaw) }));
    const response = await this.frame("pairing_response");
    return { response, pair, publicRaw, code };
  }

  async pair(code) {
    // The relay may not know the fake Mac yet: retry until it accepts.
    let attempt;
    for (const start = Date.now(); ; ) {
      attempt = await this.pairRequest(code);
      if (attempt.response.accepted || Date.now() - start > 5000) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const { response, pair, publicRaw } = attempt;
    assert.equal(response.accepted, true, response.error);
    const pcPublic = fromB64(response.pcPublicKey);
    const peer = await subtle.importKey("raw", pcPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256));
    const digest = await subtle.digest("SHA-256", Buffer.concat([text("sinew-remote-pairing-v1"), shared, pcPublic, publicRaw, text(code)]));
    this.session = await decryptJson(await aesKey(digest), response.encrypted);
    this.key = await aesKey(fromB64(this.session.deviceSecret));
    this.hello();
    await this.frame("pc_status");
    return this.session;
  }

  hello() {
    this.ws.send(JSON.stringify({ kind: "phone_hello", pcId: this.session.pcId, deviceId: this.session.deviceId, protocolVersion: 1 }));
  }

  async cmd(command, workspace) {
    const requestId = `req_${crypto.randomUUID()}`;
    const envelope = await encryptJson(this.key, { requestId, token: this.session.deviceToken, workspace, command });
    const reply = new Promise((resolve) => this.pending.set(requestId, resolve));
    this.ws.send(JSON.stringify({ kind: "phone_cipher", deviceId: this.session.deviceId, envelope }));
    const payload = await Promise.race([reply, new Promise((_, reject) => setTimeout(() => reject(new Error(`no response to ${command.type}`)), 8000))]);
    assert.equal(payload.ok, true, payload.error);
    return payload.data;
  }

  events(conversationId) {
    return this.payloads.filter((p) => p.type === "agent_event" && p.conversation_id === conversationId);
  }

  waitEvent(conversationId, type, extra = () => true) {
    return this.until(() => this.events(conversationId).find((p) => p.event.type === type && extra(p.event)));
  }
}

describe("fake Mac", () => {
  const code = String(100000 + crypto.randomInt(900000));
  const statePath = path.join(os.tmpdir(), `claake-fake-pc-test-${process.pid}.json`);
  const WS = "/Users/demo/ClaakeCode";
  let pc;
  let phone;
  let conversations;

  let relay;

  before(async () => {
    relay = await startRelay(8789, 9231);
    RELAY_URL = relay.base.replace(/^http/, "ws") + "/ws";
    pc = startFakePc({ relayUrl: RELAY_URL, pcId: `pc_test_${process.pid}`, code, statePath, speed: 0.2, log: () => {} });
    phone = new Phone();
    await phone.open();
  });

  after(() => {
    phone?.close();
    pc?.close();
    relay?.stop();
  });

  test("rejects a wrong pairing code, accepts the right one", async () => {
    const session = await phone.pair(code);
    const stranger = new Phone();
    await stranger.open();
    const wrong = await stranger.pairRequest(code === "000000" ? "000001" : "000000");
    assert.equal(wrong.response.accepted, false);
    stranger.close();
    for (const field of ["pcId", "relayUrl", "deviceId", "deviceName", "deviceToken", "deviceSecret"]) assert.ok(session[field], field);
    assert.equal(session.deviceName, "Test iPhone");
  });

  test("bootstrap returns workspaces and conversations", async () => {
    const data = await phone.cmd({ type: "bootstrap" });
    assert.equal(data.rlmAvailable, true);
    assert.deepEqual(data.workspaces.map((w) => w.name), ["ClaakeCode", "site"]);
    assert.equal(data.workspacePath, WS);
    assert.ok(data.bootstrap.conversations.length >= 4);
    assert.ok(data.bootstrap.conversations.some((c) => c.harness === "rlm"));
    assert.ok(data.bootstrap.activeConversation.history.length > 0);
    assert.deepEqual(data.activeTurns, []);
    conversations = data.bootstrap.conversations;
    const site = await phone.cmd({ type: "list_conversations" }, "/Users/demo/site");
    assert.ok(site.length >= 2);
    const models = await phone.cmd({ type: "list_models" });
    assert.ok(models.modelCatalog.length > 0 && models.providers.length > 0);
  });

  test("send_message streams a full turn and persists it", async () => {
    const id = conversations[0].id;
    const before = await phone.cmd({ type: "load_conversation", conversation_id: id }, WS);
    assert.deepEqual(await phone.cmd({ type: "send_message", conversation_id: id, text: "Ajoute un test", voice: true }, WS), { accepted: true });
    const finished = await phone.waitEvent(id, "turn_finished");
    assert.ok(finished.event.duration_ms >= 0);
    const events = phone.events(id);
    const sequences = events.map((p) => p.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(new Set(sequences).size, sequences.length);
    const types = events.map((p) => p.event.type);
    for (const type of ["turn_started", "thinking_started", "thinking_chunk", "thinking_finished", "text_chunk", "tool_started", "tool_args_delta", "tool_ready", "tool_output_delta", "tool_finished"]) {
      assert.ok(types.includes(type), type);
    }
    assert.equal(events[0].workspace_id, WS);
    const edit = events.find((p) => p.event.type === "tool_finished" && p.event.file_changes.length > 0);
    assert.equal(edit.event.file_changes[0].relativePath, "src/lib/session.ts");
    await phone.until(() => phone.payloads.filter((p) => p.type === "active_turns_changed").at(-1)?.active_turns.length === 0);
    assert.equal(phone.payloads.find((p) => p.type === "active_turns_changed").active_turns[0].conversationId, id);
    const streamed = events.filter((p) => p.event.type === "text_chunk").map((p) => p.event.delta).join("");
    assert.match(streamed, /<spoken>.+<\/spoken>$/s);
    const after = await phone.cmd({ type: "load_conversation", conversation_id: id }, WS);
    assert.ok(after.history.length > before.history.length);
    assert.equal(after.history.at(-1).parts.at(-1).text.includes("<spoken>"), true);
    const replay = await phone.cmd({ type: "replay_active_turn_events", conversation_id: id }, WS);
    assert.equal(replay.active, false);
  });

  test("cancel_turn interrupts a running turn", async () => {
    const id = conversations[1].id;
    await phone.cmd({ type: "send_message", conversation_id: id, text: "Une longue tâche" }, WS);
    await phone.waitEvent(id, "text_chunk");
    const replay = await phone.cmd({ type: "replay_active_turn_events", conversation_id: id, after_sequence: 0 }, WS);
    assert.equal(replay.active, true);
    assert.ok(replay.events.length > 0);
    assert.deepEqual(await phone.cmd({ type: "cancel_turn", conversation_id: id }, WS), { cancelled: true });
    await phone.waitEvent(id, "interrupted");
    await phone.waitEvent(id, "turn_finished");
    const types = phone.events(id).map((p) => p.event.type);
    assert.ok(types.indexOf("interrupted") < types.indexOf("turn_finished"));
    assert.ok(!types.includes("tool_finished") || types.indexOf("tool_finished") < types.indexOf("interrupted"));
    assert.deepEqual(await phone.cmd({ type: "cancel_turn", conversation_id: id }, WS), { cancelled: false });
  });

  test("question tool waits for answer_question then resumes", async () => {
    const id = conversations[2].id;
    await phone.cmd({ type: "send_message", conversation_id: id, text: "Pose-moi une question" }, WS);
    const started = await phone.waitEvent(id, "tool_started", (e) => e.name === "question");
    const ready = await phone.waitEvent(id, "tool_ready", (e) => e.id === started.event.id);
    const args = JSON.parse(ready.event.args_pretty);
    assert.equal(args.questions[0].options.length, 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(phone.events(id).some((p) => p.event.type === "turn_finished"), false);
    const answers = [[args.questions[0].options[1].label]];
    const reply = await phone.cmd({ type: "answer_question", conversation_id: id, tool_call_id: started.event.id, answers }, WS);
    assert.deepEqual(reply, { accepted: true });
    const done = await phone.waitEvent(id, "tool_finished", (e) => e.id === started.event.id);
    assert.deepEqual(done.event.meta.question_answers, answers);
    await phone.waitEvent(id, "turn_finished");
    assert.ok(phone.events(id).some((p) => p.event.type === "tool_started" && p.event.name === "edit"));
  });

  test("create, set model and delete a conversation", async () => {
    const created = await phone.cmd({ type: "create_conversation", harness: "rlm" }, WS);
    const conv = created.activeConversation;
    assert.equal(created.conversations.find((c) => c.id === conv.id).harness, "rlm");
    const settings = await phone.cmd({ type: "set_conversation_model", conversation_id: conv.id, mode: "act", model: { provider: "openai", name: "gpt-5" }, thinking: "high" }, WS);
    assert.deepEqual([settings.act.provider, settings.act.effort], ["openai", "high"]);
    const after = await phone.cmd({ type: "delete_conversation", conversation_id: conv.id }, WS);
    assert.ok(!after.conversations.some((c) => c.id === conv.id));
  });
});
