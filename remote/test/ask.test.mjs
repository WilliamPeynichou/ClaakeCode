// Claake Ask API: GitHub sign-in (against a fake GitHub), ownership, projects, conversations, documents,
// and the model subscriptions (against fake providers, see fake-providers.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { startFakeProviders } from "./fake-providers.mjs";
import { startRelay } from "./wrangler.mjs";

const GITHUB_PORT = 8792;
const PROVIDERS_PORT = 8793;
const users = { "code-alice": { id: 101, login: "alice", name: "Alice" }, "code-bob": { id: 102, login: "bob", name: "Bob" }, "code-eve": { id: 103, login: "eve", name: "Eve" } };

// Fake GitHub: authorize redirects back at once; the code names the user.
const github = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${GITHUB_PORT}`);
  if (url.pathname === "/login/oauth/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", url.searchParams.get("login_hint") || "code-alice");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }).end();
  } else if (url.pathname === "/login/oauth/access_token") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { code, client_secret } = JSON.parse(raw);
      const ok = users[code] && client_secret === "test-secret";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ok ? { access_token: `tok-${code}` } : { error: "bad_verification_code" }));
    });
  } else if (url.pathname === "/user") {
    const user = users[(req.headers.authorization || "").replace("Bearer tok-", "")];
    if (!user) return res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...user, avatar_url: null }));
  } else res.writeHead(404).end();
});
await new Promise((resolve) => github.listen(GITHUB_PORT, "127.0.0.1", resolve));

const providers = await startFakeProviders(PROVIDERS_PORT);
const relay = await startRelay(8791, 9232, {
  PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  PROVIDER_TEST_URL: `http://127.0.0.1:${PROVIDERS_PORT}`,
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-secret",
  ALLOWED_GITHUB_LOGINS: "Alice, bob",
  GITHUB_OAUTH_URL: `http://127.0.0.1:${GITHUB_PORT}`,
  GITHUB_API_URL: `http://127.0.0.1:${GITHUB_PORT}`,
});
const BASE = relay.base;
test.after(() => {
  relay.stop();
  github.close();
  providers.close();
});

/** Runs the OAuth dance by hand (no redirects followed) and returns the session cookie. */
async function signIn(code) {
  const start = await fetch(`${BASE}/v1/auth/github/start`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("claake_oauth_state="));
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.searchParams.get("client_id"), "test-client");
  authorize.searchParams.set("login_hint", code);
  const fromGithub = await fetch(authorize, { redirect: "manual" });
  const callback = await fetch(fromGithub.headers.get("location"), { redirect: "manual", headers: { cookie: stateCookie.split(";")[0] } });
  const session = callback.headers.getSetCookie().find((c) => c.startsWith("claake_session=") && !c.startsWith("claake_session=;"));
  return { location: callback.headers.get("location"), cookie: session?.split(";")[0] ?? null, raw: session };
}

function client(cookie) {
  return async (method, path, data, headers = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie, origin: BASE, ...(data !== undefined && typeof data !== "string" ? { "content-type": "application/json" } : {}), ...headers },
      body: data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data),
    });
    const type = res.headers.get("content-type") || "";
    return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : await res.text() };
  };
}

test("sign-in sets a secure session cookie and /v1/me returns the user", async () => {
  const { location, cookie, raw } = await signIn("code-alice");
  assert.equal(location, "/?tab=ask");
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /Secure/);
  assert.match(raw, /SameSite=Lax/);
  const me = await client(cookie)("GET", "/v1/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.login, "alice");
});

test("logins outside the allowlist are refused", async () => {
  const { location, cookie } = await signIn("code-eve");
  assert.equal(location, "/?auth_error=not_allowed");
  assert.equal(cookie, null);
});

test("a forged state is refused", async () => {
  const res = await fetch(`${BASE}/v1/auth/github/callback?code=code-alice&state=forged`, { redirect: "manual", headers: { cookie: "claake_oauth_state=other" } });
  assert.equal(res.headers.get("location"), "/?auth_error=state");
});

test("the API needs a session and the same origin", async () => {
  const anon = await fetch(`${BASE}/v1/projects`);
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error.code, "unauthenticated");
  const { cookie } = await signIn("code-alice");
  const cross = await fetch(`${BASE}/v1/projects`, { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(cross.status, 403);
});

test("projects, conversations, messages and documents", async () => {
  const api = client((await signIn("code-alice")).cookie);
  const created = await api("POST", "/v1/projects", { name: "Thèse", instructions: "Réponds en français." });
  assert.equal(created.status, 201);
  const projectId = created.body.data.project.id;

  const pdf = Buffer.from("%PDF-1.4 fake pdf ".repeat(200_000)); // ~3.6 MB, so it spans several chunks
  const up = await api("POST", `/v1/documents?projectId=${projectId}&name=${encodeURIComponent("plan.pdf")}&type=application/pdf`, pdf.toString("base64"));
  assert.equal(up.status, 201);
  assert.equal(up.body.data.document.size, pdf.length);
  const content = await api("GET", `/v1/documents/${up.body.data.document.id}/content`);
  assert.equal(content.headers.get("x-media-type"), "application/pdf");
  assert.ok(Buffer.from(content.body, "base64").equals(pdf));

  const conv = await api("POST", "/v1/conversations", { projectId, model: "free/model" });
  const convId = conv.body.data.conversation.id;
  const saved = await api("POST", `/v1/conversations/${convId}/messages`, {
    messages: [{ role: "user", text: "Résume le plan", attachments: [up.body.data.document.id] }, { role: "assistant", text: "Voici le résumé.", model: "free/model" }],
  });
  assert.equal(saved.status, 201);
  await api("PATCH", `/v1/conversations/${convId}`, { title: "Résumé du plan" });
  const free = await api("POST", "/v1/conversations", {});

  const detail = await api("GET", `/v1/conversations/${convId}`);
  assert.deepEqual(detail.body.data.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(detail.body.data.messages[0].attachments[0].name, "plan.pdf");
  assert.equal(detail.body.data.conversation.title, "Résumé du plan");

  const project = await api("GET", `/v1/projects/${projectId}`);
  assert.equal(project.body.data.documents.length, 1);
  assert.deepEqual(project.body.data.conversations.map((c) => c.id), [convId]);
  const list = await api("GET", "/v1/projects");
  assert.equal(list.body.data.projects[0].conversationCount, 1);
  const loose = await api("GET", "/v1/conversations?projectId=none");
  assert.deepEqual(loose.body.data.conversations.map((c) => c.id), [free.body.data.conversation.id]);

  // Deleting the project removes its conversations, messages and documents.
  await api("DELETE", `/v1/projects/${projectId}`);
  assert.equal((await api("GET", `/v1/conversations/${convId}`)).status, 404);
  assert.equal((await api("GET", `/v1/documents/${up.body.data.document.id}/content`)).status, 404);
});

test("users cannot see each other's data", async () => {
  const alice = client((await signIn("code-alice")).cookie);
  const bob = client((await signIn("code-bob")).cookie);
  const projectId = (await alice("POST", "/v1/projects", { name: "Privé" })).body.data.project.id;
  const convId = (await alice("POST", "/v1/conversations", { projectId })).body.data.conversation.id;
  assert.equal((await bob("GET", `/v1/projects/${projectId}`)).status, 404);
  assert.equal((await bob("GET", `/v1/conversations/${convId}`)).status, 404);
  assert.equal((await bob("POST", "/v1/conversations", { projectId })).status, 404);
  assert.equal((await bob("POST", `/v1/conversations/${convId}/messages`, { messages: [{ role: "user", text: "hi" }] })).status, 404);
  assert.ok(!(await bob("GET", "/v1/projects")).body.data.projects.some((p) => p.id === projectId));
});

test("logout ends the session", async () => {
  const { cookie } = await signIn("code-alice");
  const api = client(cookie);
  assert.equal((await api("POST", "/v1/auth/logout")).status, 200);
  assert.equal((await api("GET", "/v1/me")).status, 401);
});

test("documents over 10 MB are refused", async () => {
  const api = client((await signIn("code-alice")).cookie);
  const projectId = (await api("POST", "/v1/projects", { name: "Gros" })).body.data.project.id;
  const big = Buffer.alloc(10 * 1024 * 1024 + 10, 1).toString("base64");
  const res = await api("POST", `/v1/documents?projectId=${projectId}&name=big.bin`, big);
  assert.equal(res.status, 413);
});

// --- Subscriptions ---

/** Posts a model call through the Worker; the streamed body comes back as text. */
const chat = (api, provider, body) => api("POST", `/v1/providers/${provider}/chat`, body);
const lastCall = (path) => providers.calls.filter((c) => c.path === path).at(-1);

test("subscriptions: nothing is connected at first", async () => {
  const api = client((await signIn("code-bob")).cookie);
  assert.deepEqual((await api("GET", "/v1/providers")).body.data.accounts, []);
  const res = await chat(api, "anthropic", { model: "claude-sonnet-5-5", messages: [] });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "not_connected");
  assert.equal((await api("POST", "/v1/providers/nope/login")).status, 404);
});

test("Claude: paste the code, chat, credentials stay encrypted", async () => {
  const api = client((await signIn("code-alice")).cookie);
  const start = (await api("POST", "/v1/providers/anthropic/login")).body.data;
  const authorize = new URL(start.url);
  assert.equal(authorize.origin + authorize.pathname, "https://claude.ai/oauth/authorize");
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const state = authorize.searchParams.get("state");

  const wrong = await api("POST", `/v1/providers/anthropic/login/${start.loginId}`, { input: "claude-code#other-state" });
  assert.equal(wrong.status, 400);
  const done = await api("POST", `/v1/providers/anthropic/login/${start.loginId}`, { input: `claude-code#${state}` });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.label, "alice@example.com");
  // A login can be used once.
  assert.equal((await api("POST", `/v1/providers/anthropic/login/${start.loginId}`, { input: `claude-code#${state}` })).status, 410);
  assert.deepEqual((await api("GET", "/v1/providers")).body.data.accounts.map((a) => a.provider), ["anthropic"]);

  const res = await chat(api, "anthropic", { model: "claude-sonnet-5-5", max_tokens: 100, system: "Sois bref.", messages: [{ role: "user", content: [{ type: "text", text: "Salut" }] }] });
  assert.equal(res.status, 200);
  assert.match(res.body, /text_delta/);
  const up = lastCall("/api.anthropic.com/v1/messages");
  assert.equal(up.headers.authorization, "Bearer anthropic-at-1");
  assert.match(up.headers["anthropic-beta"], /oauth-2025-04-20/);
  assert.deepEqual(up.json.system.map((s) => s.text), ["You are Claude Code, Anthropic's official CLI for Claude.", "Sois bref."]);
  assert.equal(up.json.stream, true);

  const rows = execFileSync("npx", ["wrangler", "d1", "execute", "claake-ask", "--local", "--persist-to", relay.state, "--json", "--command", "SELECT secret FROM provider_accounts"], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    encoding: "utf8",
  });
  assert.ok(rows.includes("secret"));
  assert.ok(!rows.includes("anthropic-at-1") && !rows.includes("anthropic-rt-1"), "tokens must not be stored in clear");
});

test("Claude: an expiring token is refreshed, a refused one is refreshed and retried", async () => {
  const api = client((await signIn("code-alice")).cookie);
  // Reconnect with a token that expires within the five-minute margin.
  providers.state.expiresIn = 60;
  const start = (await api("POST", "/v1/providers/anthropic/login")).body.data;
  const state = new URL(start.url).searchParams.get("state");
  await api("POST", `/v1/providers/anthropic/login/${start.loginId}`, { input: `claude-code#${state}` });
  providers.state.expiresIn = 3600;
  const before = providers.state.generation.anthropic;
  const res = await chat(api, "anthropic", { model: "claude-sonnet-5-5", messages: [{ role: "user", content: [{ type: "text", text: "Salut" }] }] });
  assert.equal(res.status, 200);
  assert.equal(providers.state.generation.anthropic, before + 1);
  assert.equal(lastCall("/api.anthropic.com/v1/messages").headers.authorization, `Bearer anthropic-at-${before + 1}`);

  providers.state.reject = { provider: "anthropic", status: 401 };
  const retried = await chat(api, "anthropic", { model: "claude-sonnet-5-5", messages: [{ role: "user", content: [{ type: "text", text: "Salut" }] }] });
  assert.equal(retried.status, 200);
  assert.equal(providers.state.generation.anthropic, before + 2);

  providers.state.reject = { provider: "anthropic", status: 429 };
  const limited = await chat(api, "anthropic", { model: "claude-sonnet-5-5", messages: [] });
  assert.equal(limited.status, 429);
  assert.match(limited.body.error.message, /Limite de ton abonnement Claude/);
});

test("subscriptions are private to their user", async () => {
  const bob = client((await signIn("code-bob")).cookie);
  assert.deepEqual((await bob("GET", "/v1/providers")).body.data.accounts, []);
  assert.equal((await chat(bob, "anthropic", { model: "claude-sonnet-5-5", messages: [] })).status, 404);
  const alice = client((await signIn("code-alice")).cookie);
  const start = (await alice("POST", "/v1/providers/openai/login")).body.data;
  assert.equal((await bob("POST", `/v1/providers/openai/login/${start.loginId}`, { input: "x" })).status, 410);
});

test("ChatGPT: paste the localhost URL, the account id is sent", async () => {
  const api = client((await signIn("code-alice")).cookie);
  const start = (await api("POST", "/v1/providers/openai/login")).body.data;
  const state = new URL(start.url).searchParams.get("state");
  const done = await api("POST", `/v1/providers/openai/login/${start.loginId}`, { input: `  http://localhost:1455/auth/callback?code=oa-code&scope=openid&state=${state}\n` });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.label, "alice@example.com");
  const res = await chat(api, "openai", { model: "gpt-6-luna", instructions: "Sois bref.", input: [], store: true });
  assert.equal(res.status, 200);
  assert.match(res.body, /ChatGPT\./);
  const up = lastCall("/chatgpt.com/backend-api/codex/responses");
  assert.equal(up.headers["chatgpt-account-id"], "acct-1");
  assert.equal(up.headers.originator, "claakecode_desktop");
  assert.equal(up.json.store, false);
});

test("Gemini: project discovery, model naming and the fallback endpoint", async () => {
  const api = client((await signIn("code-alice")).cookie);
  const start = (await api("POST", "/v1/providers/google/login")).body.data;
  const state = new URL(start.url).searchParams.get("state");
  const done = await api("POST", `/v1/providers/google/login/${start.loginId}`, { input: `http://localhost:51121/oauth-callback?state=${state}&code=g-code` });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.label, "alice@gmail.com");
  const body = { model: "gemini-3.1-pro", request: { contents: [{ role: "user", parts: [{ text: "Salut" }] }], systemInstruction: { role: "user", parts: [{ text: "Sois bref." }] } } };
  const res = await chat(api, "google", body);
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /Gemini\./);
  const up = lastCall("/cloudcode-pa.googleapis.com/v1internal:streamGenerateContent");
  assert.equal(up.json.project, "proj-42");
  assert.equal(up.json.model, "gemini-pro-agent");
  assert.match(up.json.request.systemInstruction.parts[0].text, /^You are Antigravity/);
  assert.equal(up.json.request.systemInstruction.parts.at(-1).text, "Sois bref.");
});

test("Kimi: device sign-in is pending until confirmed", async () => {
  const api = client((await signIn("code-alice")).cookie);
  const start = (await api("POST", "/v1/providers/kimi/login")).body.data;
  assert.equal(start.userCode, "KIMI-1234");
  assert.equal((await api("POST", `/v1/providers/kimi/login/${start.loginId}`, {})).body.data.pending, true);
  assert.equal((await api("POST", `/v1/providers/kimi/login/${start.loginId}`, {})).body.data.connected, true);
  const res = await chat(api, "kimi", { model: "kimi-for-coding", messages: [{ role: "user", content: "Salut" }] });
  assert.match(res.body, /Kimi\./);
  const up = lastCall("/api.kimi.com/coding/v1/chat/completions");
  assert.equal(up.headers["x-msh-platform"], "kimi_cli");
  assert.ok(up.headers["x-msh-device-id"]);
});

test("Mistral: an API key, checked before it is saved", async () => {
  const api = client((await signIn("code-alice")).cookie);
  assert.equal((await api("PUT", "/v1/providers/mistral/key", { key: "mistral-bad" })).status, 400);
  assert.equal((await api("PUT", "/v1/providers/mistral/key", { key: " mistral-good " })).status, 200);
  const models = (await api("GET", "/v1/providers/mistral/models")).body.data.models;
  assert.deepEqual(models, [{ id: "mistral-large-latest", context: 128000, images: true }]);
  const res = await chat(api, "mistral", { model: "mistral-large-latest", messages: [{ role: "user", content: "Salut" }] });
  assert.match(res.body, /Mistral\./);
  assert.equal((await api("PUT", "/v1/providers/anthropic/key", { key: "x" })).status, 400);
});

test("removing a subscription forgets it", async () => {
  const api = client((await signIn("code-alice")).cookie);
  assert.equal((await api("DELETE", "/v1/providers/kimi")).status, 200);
  const left = (await api("GET", "/v1/providers")).body.data.accounts.map((a) => a.provider);
  assert.deepEqual(left, ["anthropic", "google", "mistral", "openai"]);
  assert.equal((await chat(api, "kimi", { model: "kimi-for-coding", messages: [] })).status, 404);
});
