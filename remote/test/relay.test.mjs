import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startRelay } from "./wrangler.mjs";

let relay;
let BASE;
let WS_URL;

before(async () => {
  relay = await startRelay(8788, 9230);
  BASE = relay.base;
  WS_URL = BASE.replace(/^http/, "ws") + "/ws";
});

after(() => relay?.stop());

// A WebSocket with a queue of received JSON messages.
async function connect() {
  const ws = new WebSocket(WS_URL);
  const queue = [];
  const waiters = [];
  ws.closeEvent = new Promise((resolve) => ws.addEventListener("close", resolve));
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  ws.sendJson = (frame) => ws.send(JSON.stringify(frame));
  ws.next = () =>
    new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), 5000);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  return ws;
}

const id = () => Math.random().toString(36).slice(2);

async function registerPc() {
  const pcId = `pc_${id()}`;
  const pc = await connect();
  pc.sendJson({ kind: "pc_hello", pc_id: pcId, protocol_version: 1 });
  assert.deepEqual(await pc.next(), { kind: "pc_registered", pc_id: pcId });
  return { pc, pcId };
}

async function connectPhone(pc, pcId, deviceId) {
  const phone = await connect();
  phone.sendJson({ kind: "phone_hello", pcId, deviceId });
  assert.deepEqual(await phone.next(), { kind: "pc_status", reachable: true });
  assert.deepEqual(await pc.next(), { kind: "phone_connected", device_id: deviceId });
  return phone;
}

test("HTTP endpoints", async () => {
  assert.deepEqual(await (await fetch(`${BASE}/healthz`)).json(), { ok: true });
  const res = await fetch(`${BASE}/vapid-public-key`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok("publicKey" in (await res.json()));
  assert.equal((await fetch(`${BASE}/`)).status, 200);
});

test("pairing flow", async () => {
  const { pc, pcId } = await registerPc();
  const code = `code_${id()}`;
  pc.sendJson({ kind: "pc_pairing_code", pc_id: pcId, code, expires_at_ms: Date.now() + 60_000 });

  const phone = await connect();
  phone.sendJson({ kind: "phone_pair_request", code, deviceName: "iPhone", phonePublicKey: "pk" });
  const request = await pc.next();
  assert.equal(request.kind, "pairing_request");
  assert.equal(request.code, code);
  assert.equal(request.device_name, "iPhone");
  assert.equal(request.phone_public_key, "pk");
  assert.ok(request.phone_conn_id);

  const encrypted = { nonce: "n", ciphertext: "c" };
  pc.sendJson({ kind: "pc_pair_response", phone_conn_id: request.phone_conn_id, accepted: true, pc_public_key: "pcpk", encrypted });
  assert.deepEqual(await phone.next(), {
    kind: "pairing_response",
    accepted: true,
    pcPublicKey: "pcpk",
    encrypted,
    error: null,
  });
  pc.close();
  phone.close();
});

test("unknown and expired codes are rejected", async () => {
  const { pc, pcId } = await registerPc();
  pc.sendJson({ kind: "pc_pairing_code", pc_id: pcId, code: "old", expires_at_ms: Date.now() - 1000 });
  for (const code of ["old", "nope"]) {
    const phone = await connect();
    phone.sendJson({ kind: "phone_pair_request", code });
    const res = await phone.next();
    assert.equal(res.kind, "pairing_response");
    assert.equal(res.accepted, false);
    phone.close();
  }
  pc.close();
});

test("cipher routing, ping, revoke and disconnect", async () => {
  const { pc, pcId } = await registerPc();
  const deviceId = `dev_${id()}`;
  const phone = await connectPhone(pc, pcId, deviceId);

  phone.sendJson({ kind: "phone_cipher", deviceId, envelope: { nonce: "a", ciphertext: "b" } });
  assert.deepEqual(await pc.next(), { kind: "phone_cipher", device_id: deviceId, envelope: { nonce: "a", ciphertext: "b" } });
  pc.sendJson({ kind: "pc_cipher", device_id: deviceId, envelope: { nonce: "c", ciphertext: "d" } });
  assert.deepEqual(await phone.next(), { kind: "pc_cipher", envelope: { nonce: "c", ciphertext: "d" } });

  phone.send('{"kind":"ping"}');
  assert.deepEqual(await phone.next(), { kind: "pong" });
  pc.send('{"kind":"ping"}');
  assert.deepEqual(await pc.next(), { kind: "pong" });

  pc.sendJson({ kind: "pc_nope" });
  assert.equal((await pc.next()).kind, "error");
  phone.sendJson({ kind: "phone_nope" });
  assert.equal((await phone.next()).kind, "relay_error");
  phone.sendJson({ kind: "weird" });
  assert.equal((await phone.next()).kind, "relay_error");

  pc.sendJson({ kind: "pc_revoke_device", device_id: deviceId });
  assert.deepEqual(await phone.next(), { kind: "device_revoked" });
  assert.equal((await phone.closeEvent).code, 4001);
  assert.deepEqual(await pc.next(), { kind: "phone_disconnected", device_id: deviceId });
  pc.close();
});

test("a new pc_hello replaces the older socket", async () => {
  const { pc, pcId } = await registerPc();
  const second = await connect();
  second.sendJson({ kind: "pc_hello", pc_id: pcId, protocol_version: 1 });
  assert.equal((await second.next()).kind, "pc_registered");
  const closed = await pc.closeEvent;
  assert.equal(closed.code, 4000);
  assert.equal(closed.reason, "replaced");

  const phone = await connectPhone(second, pcId, `dev_${id()}`);
  second.close();
  assert.deepEqual(await phone.next(), { kind: "pc_status", reachable: false });
  phone.close();
});

test("a new phone_hello replaces the older socket of the same device", async () => {
  const { pc, pcId } = await registerPc();
  const deviceId = `dev_${id()}`;
  const stale = await connectPhone(pc, pcId, deviceId);
  const fresh = await connectPhone(pc, pcId, deviceId);
  const closed = await stale.closeEvent;
  assert.equal(closed.code, 4000);
  assert.equal(closed.reason, "replaced");

  pc.sendJson({ kind: "pc_cipher", device_id: deviceId, envelope: { nonce: "e", ciphertext: "f" } });
  assert.deepEqual(await fresh.next(), { kind: "pc_cipher", envelope: { nonce: "e", ciphertext: "f" } });
  fresh.close();
  assert.deepEqual(await pc.next(), { kind: "phone_disconnected", device_id: deviceId });
  pc.close();
});


test("PC disconnect and reconnect update the phone", async () => {
  const { pc, pcId } = await registerPc();
  const deviceId = `dev_${id()}`;
  const phone = await connectPhone(pc, pcId, deviceId);
  pc.close();
  assert.deepEqual(await phone.next(), { kind: "pc_status", reachable: false });

  const pc2 = await connect();
  pc2.sendJson({ kind: "pc_hello", pc_id: pcId, protocol_version: 1 });
  assert.equal((await pc2.next()).kind, "pc_registered");
  assert.deepEqual(await phone.next(), { kind: "pc_status", reachable: true });
  assert.deepEqual(await pc2.next(), { kind: "phone_connected", device_id: deviceId });
  phone.close();
  assert.deepEqual(await pc2.next(), { kind: "phone_disconnected", device_id: deviceId });
  pc2.close();
});

test("large frames are relayed", async () => {
  const { pc, pcId } = await registerPc();
  const deviceId = `dev_${id()}`;
  const phone = await connectPhone(pc, pcId, deviceId);
  const big = "x".repeat(Number(process.env.BIG_BYTES || 8 * 1024 * 1024));
  phone.sendJson({ kind: "phone_cipher", deviceId, envelope: { ciphertext: big } });
  assert.equal((await pc.next()).envelope.ciphertext.length, big.length);
  pc.close();
  phone.close();
});
