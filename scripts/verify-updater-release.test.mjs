import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { reconcileManifest, verifySignature } from "./verify-updater-release.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const id = Buffer.from("01234567");
const publicPacket = Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ format: "der", type: "spki" }).subarray(-32)]);
const key = Buffer.from(`untrusted comment: test
${publicPacket.toString("base64")}
`).toString("base64");
const bytes = Buffer.from("updater test package");
function signature(algorithm = "ED") {
  const payload = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  const sig = sign(null, payload, privateKey);
  const packet = Buffer.concat([Buffer.from(algorithm), id, sig]);
  const comment = "timestamp:123\tfile:app.zip";
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
  return Buffer.from(`untrusted comment: test
${packet.toString("base64")}
trusted comment: ${comment}
${global.toString("base64")}
`).toString("base64");
}
const sig = signature();
const targets = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"];
function manifest() {
  return { version: "0.2.14", platforms: Object.fromEntries(targets.map(target => [target, {
    url: "https://github.com/WilliamPeynichou/ClaakeCode/releases/latest/download/app.zip", signature: "stale",
  }])) };
}
const load = name => name.endsWith(".sig") ? Buffer.from(sig) : bytes;

test("accepts Ed and ED signatures; rejects altered package and trusted comment", () => {
  for (const algorithm of ["Ed", "ED"]) verifySignature(bytes, signature(algorithm), key);
  assert.throws(() => verifySignature(Buffer.from("altered"), sig, key), /signature verification failed/);
  const decoded = Buffer.from(sig, "base64").toString().replace("timestamp:123", "timestamp:456");
  assert.throws(() => verifySignature(bytes, Buffer.from(decoded).toString("base64"), key), /trusted comment/);
});

test("pins URLs, repairs stale signatures, and loads each artifact only once", () => {
  const calls = [];
  const result = reconcileManifest(manifest(), "v0.2.14", key, name => { calls.push(name); return load(name); });
  assert.deepEqual(calls, ["app.zip.sig", "app.zip"]);
  for (const platform of Object.values(result.platforms)) {
    assert.equal(platform.signature, sig);
    assert.equal(platform.url, "https://github.com/WilliamPeynichou/ClaakeCode/releases/download/v0.2.14/app.zip");
  }
});

test("rejects missing desktop targets, wrong release version and external URLs", () => {
  for (const target of targets) {
    const incomplete = manifest(); delete incomplete.platforms[target];
    assert.throws(() => reconcileManifest(incomplete, "v0.2.14", key, load), /Missing updater platform/);
  }
  assert.throws(() => reconcileManifest(manifest(), "v0.2.15", key, load), /version differ/);
  const external = manifest(); external.platforms[targets[0]].url = "https://example.org/app.zip";
  assert.throws(() => reconcileManifest(external, "v0.2.14", key, load), /Unexpected updater URL/);
});
