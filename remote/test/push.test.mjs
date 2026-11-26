import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const ece = require("http_ece");

// push.ts is TypeScript: bundle it to ESM in memory and import it.
const { outputFiles } = await build({
  entryPoints: ["worker/push.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const code = outputFiles[0].text;
const push = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const b64u = (buf) => Buffer.from(buf).toString("base64url");

test("encrypted payload decrypts with http_ece", async () => {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
  const plaintext = JSON.stringify({ title: "Claake", body: "Réponse prête ✓", conversationId: "c1" });

  const body = await push.encryptPayload(subscription, new TextEncoder().encode(plaintext));
  const decrypted = ece.decrypt(Buffer.from(body), {
    version: "aes128gcm",
    privateKey: ua,
    authSecret: b64u(auth),
  });
  assert.equal(decrypted.toString("utf8"), plaintext);
});

test("VAPID header carries a valid ES256 JWT", async () => {
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.privateKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const vapid = { publicKey: b64u(publicKey), privateKey: jwk.d, subject: "mailto:test@example.com" };
  const now = Date.now();

  const header = await push.vapidAuthorization("https://web.push.apple.com/some/path?x=1", vapid, now);
  const match = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(match, header);
  const [, h, c, s, k] = match;
  assert.equal(k, vapid.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, vapid.subject);
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600);
  assert.ok(
    crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")),
  );
});
