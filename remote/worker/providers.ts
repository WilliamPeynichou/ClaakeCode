/// <reference types="@cloudflare/workers-types" />
// Model subscriptions for Claake Ask: Claude, ChatGPT, Gemini and Kimi (OAuth), Mistral (API key).
// The phone signs in once per provider; the credentials stay here, AES-GCM encrypted in D1, and this
// Worker refreshes them and relays the model calls. The phone builds each provider's request body;
// the account-specific parts (auth headers, Claude Code / Codex / Antigravity envelopes) are added here.
// Clients, scopes and envelopes mirror the desktop app (crates/claakecode-*).
import { ApiError, body, ok, type User } from "./ask";

export interface ProvidersEnv {
  DB: D1Database;
  /** Base64 of 32 random bytes. */
  PROVIDER_ENCRYPTION_KEY?: string;
  /** Tests only: every upstream URL goes to `${PROVIDER_TEST_URL}/<host><path>`. */
  PROVIDER_TEST_URL?: string;
}

type Credential = {
  access: string;
  refresh?: string;
  expiresAt?: number;
  accountId?: string;
  project?: string;
  deviceId?: string;
};
type Login = { verifier?: string; state?: string; deviceCode?: string; deviceId?: string };
type Started = { url: string; userCode?: string };
type Finished = { credential: Credential; label: string | null } | { pending: true };
type Call = { urls: string[]; headers: Record<string, string>; body: unknown };

type Spec = {
  label: string;
  start?(env: ProvidersEnv, login: Login): Promise<Started>;
  finish?(env: ProvidersEnv, login: Login, input: string): Promise<Finished>;
  refresh?(env: ProvidersEnv, credential: Credential): Promise<Credential>;
  call(credential: Credential, body: Record<string, unknown>): Call;
};

const LOGIN_MS = 15 * 60_000;
const REFRESH_SKEW_MS = 5 * 60_000;
const now = () => Date.now();

// --- Encoding and crypto ---

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const b64url = (bytes: Uint8Array) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomUrl = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function challenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function jwtClaims(token: string | undefined): Record<string, any> {
  try {
    const payload = token!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(fromB64(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))));
  } catch {
    return {};
  }
}

async function aesKey(env: ProvidersEnv): Promise<CryptoKey> {
  if (!env.PROVIDER_ENCRYPTION_KEY) throw new ApiError(503, "not_configured", "Les abonnements ne sont pas encore configurés sur le serveur.");
  return crypto.subtle.importKey("raw", fromB64(env.PROVIDER_ENCRYPTION_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** The row's owner is bound as additional data, so a secret can't be moved to another account. */
async function seal(env: ProvidersEnv, value: unknown, owner: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(owner) }, await aesKey(env), data);
  return `${toB64(iv)}.${toB64(new Uint8Array(sealed))}`;
}

async function unseal<T>(env: ProvidersEnv, sealed: string, owner: string): Promise<T> {
  const [iv, data] = sealed.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: new TextEncoder().encode(owner) }, await aesKey(env), fromB64(data));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

// --- Upstream calls ---

function upstream(env: ProvidersEnv, url: string, init: RequestInit): Promise<Response> {
  if (!env.PROVIDER_TEST_URL) return fetch(url, init);
  const u = new URL(url);
  return fetch(`${env.PROVIDER_TEST_URL}/${u.host}${u.pathname}${u.search}`, init);
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(fields).toString(),
});
const jsonPost = (value: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json", ...headers },
  body: JSON.stringify(value),
});

/** A sign-in error: the user retries the whole sign-in. */
async function tokens<T>(res: Response, label: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  console.warn("provider token error", label, res.status, (await res.text()).slice(0, 300));
  if (res.status >= 500) throw new ApiError(502, "provider_down", `${label} ne répond pas. Réessaie plus tard.`);
  throw new ApiError(400, "provider_refused", `${label} a refusé la connexion. Recommence la connexion.`);
}

/** The code from a pasted callback URL, or Claude's "code#state". */
function pasted(input: string, login: Login): string {
  const text = input.trim();
  let code: string | null = null;
  let state: string | null = null;
  if (/[?&]code=/.test(text) || text.startsWith("code=")) {
    const query = new URLSearchParams(text.includes("?") ? text.slice(text.indexOf("?") + 1).split("#")[0] : text);
    code = query.get("code");
    state = query.get("state");
  } else if (text) {
    const [first, second] = text.split("#");
    code = first;
    state = second ?? null;
  }
  if (!code) throw new ApiError(400, "invalid_code", "Colle l'adresse complète de la page, ou le code affiché.");
  if (state && login.state && state !== login.state) throw new ApiError(400, "invalid_code", "Ce code vient d'une autre connexion. Recommence.");
  return code;
}

const expiresAt = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? now() + seconds * 1000 : undefined);

// --- Providers ---

const CLAUDE = {
  client: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorize: "https://claude.ai/oauth/authorize",
  token: "https://platform.claude.com/v1/oauth/token",
  // Claude's manual sign-in page: it shows a code to copy instead of calling a local server.
  redirect: "https://platform.claude.com/oauth/code/callback",
  scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  system: "You are Claude Code, Anthropic's official CLI for Claude.",
};

const CODEX = {
  client: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorize: "https://auth.openai.com/oauth/authorize",
  token: "https://auth.openai.com/oauth/token",
  // The registered redirect is the desktop's local server; on the phone the page fails to load and the user pastes its URL.
  redirect: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
  originator: "claakecode_desktop",
};

const ANTIGRAVITY = {
  client: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  // An installed-app client: its secret is public by design (see crates/claakecode-google/src/auth.rs).
  secret: "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",
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  redirect: "http://localhost:51121/oauth-callback",
  scope:
    "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
  bases: ["https://daily-cloudcode-pa.googleapis.com/v1internal", "https://cloudcode-pa.googleapis.com/v1internal"],
  userAgent: "antigravity/2.0.0 darwin/arm64",
  fallbackProject: "rising-fact-p41fc",
  system:
    "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**",
};

const KIMI = {
  client: "17e5f671-d194-4dfb-9706-5516cb48c098",
  auth: "https://auth.kimi.com",
  api: "https://api.kimi.com/coding/v1/chat/completions",
};

function authorizeUrl(base: string, params: Record<string, string>): string {
  return `${base}?${new URLSearchParams(params).toString()}`;
}

async function pkce(login: Login): Promise<string> {
  login.verifier = randomUrl();
  login.state = randomUrl(16);
  return challenge(login.verifier);
}

const kimiHeaders = (deviceId: string) => ({
  "X-Msh-Platform": "kimi_cli",
  "X-Msh-Version": "0.4.0",
  "X-Msh-Device-Name": "Claake iPhone",
  "X-Msh-Device-Model": "iPhone",
  "X-Msh-Os-Version": "ios",
  "X-Msh-Device-Id": deviceId,
});

/** Antigravity names pro models by thinking level, as crates/claakecode-google/src/model_info.rs does. */
function antigravityModel(model: string, level: string): string {
  if (model === "gemini-3.5-flash") return "gemini-3.5-flash-low";
  if (model === "gemini-3.1-pro") return "gemini-pro-agent";
  return /-pro\b/.test(model) ? `${model}-${level}` : model;
}

type TokenBody = { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string };

const SPECS: Record<string, Spec> = {
  anthropic: {
    label: "Claude",
    async start(_env, login) {
      const code_challenge = await pkce(login);
      return {
        url: authorizeUrl(CLAUDE.authorize, {
          code: "true",
          client_id: CLAUDE.client,
          response_type: "code",
          redirect_uri: CLAUDE.redirect,
          scope: CLAUDE.scope,
          code_challenge,
          code_challenge_method: "S256",
          state: login.state!,
        }),
      };
    },
    async finish(env, login, input) {
      const code = pasted(input, login);
      const body = await tokens<TokenBody & { account?: { email_address?: string } }>(
        await upstream(env, CLAUDE.token, jsonPost({
          grant_type: "authorization_code",
          client_id: CLAUDE.client,
          code,
          state: login.state,
          redirect_uri: CLAUDE.redirect,
          code_verifier: login.verifier,
        })),
        "Claude",
      );
      return {
        credential: { access: body.access_token, refresh: body.refresh_token, expiresAt: expiresAt(body.expires_in) },
        label: body.account?.email_address ?? null,
      };
    },
    async refresh(env, c) {
      const body = await tokens<TokenBody>(
        await upstream(env, CLAUDE.token, jsonPost({ grant_type: "refresh_token", client_id: CLAUDE.client, refresh_token: c.refresh })),
        "Claude",
      );
      return { ...c, access: body.access_token, refresh: body.refresh_token ?? c.refresh, expiresAt: expiresAt(body.expires_in) };
    },
    call(c, body) {
      const own = typeof body.system === "string" && body.system.trim() ? [{ type: "text", text: body.system }] : [];
      return {
        urls: ["https://api.anthropic.com/v1/messages"],
        headers: {
          authorization: `Bearer ${c.access}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
          "x-app": "cli",
          "user-agent": "claude-cli/2.1.290",
        },
        body: { ...body, stream: true, system: [{ type: "text", text: CLAUDE.system }, ...own] },
      };
    },
  },

  openai: {
    label: "ChatGPT",
    async start(_env, login) {
      const code_challenge = await pkce(login);
      return {
        url: authorizeUrl(CODEX.authorize, {
          response_type: "code",
          client_id: CODEX.client,
          redirect_uri: CODEX.redirect,
          scope: CODEX.scope,
          code_challenge,
          code_challenge_method: "S256",
          id_token_add_organizations: "true",
          codex_cli_simplified_flow: "true",
          state: login.state!,
          originator: CODEX.originator,
        }),
      };
    },
    async finish(env, login, input) {
      const code = pasted(input, login);
      const body = await tokens<TokenBody>(
        await upstream(env, CODEX.token, form({
          grant_type: "authorization_code",
          code,
          redirect_uri: CODEX.redirect,
          client_id: CODEX.client,
          code_verifier: login.verifier!,
        })),
        "ChatGPT",
      );
      const claims = jwtClaims(body.id_token);
      return {
        credential: {
          access: body.access_token,
          refresh: body.refresh_token,
          expiresAt: expiresAt(body.expires_in) ?? (jwtClaims(body.access_token).exp ?? 0) * 1000,
          accountId: claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? claims.chatgpt_account_id,
        },
        label: claims.email ?? claims["https://api.openai.com/profile"]?.email ?? null,
      };
    },
    async refresh(env, c) {
      const body = await tokens<TokenBody>(
        await upstream(env, CODEX.token, form({ grant_type: "refresh_token", client_id: CODEX.client, refresh_token: c.refresh! })),
        "ChatGPT",
      );
      const accountId = jwtClaims(body.id_token)["https://api.openai.com/auth"]?.chatgpt_account_id ?? c.accountId;
      const expiry = expiresAt(body.expires_in) ?? (jwtClaims(body.access_token).exp ?? 0) * 1000;
      return { ...c, access: body.access_token, refresh: body.refresh_token ?? c.refresh, expiresAt: expiry, accountId };
    },
    call(c, body) {
      return {
        urls: ["https://chatgpt.com/backend-api/codex/responses"],
        headers: {
          authorization: `Bearer ${c.access}`,
          accept: "text/event-stream",
          "openai-beta": "responses=experimental",
          originator: CODEX.originator,
          ...(c.accountId ? { "chatgpt-account-id": c.accountId } : {}),
        },
        body: { ...body, store: false, stream: true },
      };
    },
  },

  google: {
    label: "Gemini",
    async start(_env, login) {
      const code_challenge = await pkce(login);
      return {
        url: authorizeUrl(ANTIGRAVITY.authorize, {
          response_type: "code",
          client_id: ANTIGRAVITY.client,
          redirect_uri: ANTIGRAVITY.redirect,
          scope: ANTIGRAVITY.scope,
          code_challenge,
          code_challenge_method: "S256",
          access_type: "offline",
          prompt: "consent",
          state: login.state!,
        }),
      };
    },
    async finish(env, login, input) {
      const code = pasted(input, login);
      const body = await tokens<TokenBody>(
        await upstream(env, ANTIGRAVITY.token, form({
          grant_type: "authorization_code",
          code,
          code_verifier: login.verifier!,
          redirect_uri: ANTIGRAVITY.redirect,
          client_id: ANTIGRAVITY.client,
          client_secret: ANTIGRAVITY.secret,
        })),
        "Gemini",
      );
      const auth = { authorization: `Bearer ${body.access_token}` };
      const info = (await (await upstream(env, "https://www.googleapis.com/oauth2/v2/userinfo", { headers: auth })).json().catch(() => ({}))) as { email?: string };
      // The Code Assist project the requests are billed to; the desktop falls back to a shared one the same way.
      const load = await upstream(env, `${ANTIGRAVITY.bases[1]}:loadCodeAssist`, jsonPost(
        { metadata: { ideType: "ANTIGRAVITY", ideVersion: "2.0.0", ideName: "antigravity", platform: "DARWIN_ARM64", pluginType: "GEMINI" } },
        { ...auth, "user-agent": `${ANTIGRAVITY.userAgent} google-api-nodejs-client/10.3.0`, "x-goog-api-client": "gl-node/22.21.1" },
      ));
      const project = load.ok ? ((await load.json()) as { cloudaicompanionProject?: string | { id?: string } }).cloudaicompanionProject : undefined;
      return {
        credential: {
          access: body.access_token,
          refresh: body.refresh_token,
          expiresAt: expiresAt(body.expires_in),
          project: (typeof project === "string" ? project : project?.id) || ANTIGRAVITY.fallbackProject,
        },
        label: info.email ?? null,
      };
    },
    async refresh(env, c) {
      const body = await tokens<TokenBody>(
        await upstream(env, ANTIGRAVITY.token, form({
          grant_type: "refresh_token",
          refresh_token: c.refresh!,
          client_id: ANTIGRAVITY.client,
          client_secret: ANTIGRAVITY.secret,
        })),
        "Gemini",
      );
      return { ...c, access: body.access_token, refresh: body.refresh_token ?? c.refresh, expiresAt: expiresAt(body.expires_in) };
    },
    call(c, body) {
      const request = (body.request ?? {}) as { systemInstruction?: { parts?: unknown[] }; generationConfig?: { thinkingConfig?: { thinkingLevel?: string } } };
      const level = request.generationConfig?.thinkingConfig?.thinkingLevel ?? "high";
      const ignore = `Please ignore following [ignore]${ANTIGRAVITY.system}[/ignore]`;
      return {
        urls: ANTIGRAVITY.bases.map((base) => `${base}:streamGenerateContent?alt=sse`),
        headers: { authorization: `Bearer ${c.access}`, accept: "text/event-stream", "user-agent": ANTIGRAVITY.userAgent },
        body: {
          model: antigravityModel(String(body.model), level),
          project: c.project,
          request: {
            ...request,
            systemInstruction: { role: "user", parts: [{ text: ANTIGRAVITY.system }, { text: ignore }, ...(request.systemInstruction?.parts ?? [])] },
          },
          requestType: "agent",
          userAgent: "antigravity",
          requestId: `agent-${crypto.randomUUID()}`,
        },
      };
    },
  },

  kimi: {
    label: "Kimi",
    async start(env, login) {
      login.deviceId = crypto.randomUUID();
      const res = await upstream(env, `${KIMI.auth}/api/oauth/device_authorization`, {
        ...form({ client_id: KIMI.client }),
        headers: { ...form({}).headers, ...kimiHeaders(login.deviceId) },
      });
      const body = await tokens<{ user_code: string; device_code: string; verification_uri_complete: string }>(res, "Kimi");
      login.deviceCode = body.device_code;
      return { url: body.verification_uri_complete, userCode: body.user_code };
    },
    async finish(env, login) {
      const res = await upstream(env, `${KIMI.auth}/api/oauth/token`, {
        ...form({ client_id: KIMI.client, device_code: login.deviceCode!, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
        headers: { ...form({}).headers, ...kimiHeaders(login.deviceId!) },
      });
      if (!res.ok) {
        const error = ((await res.clone().json().catch(() => ({}))) as { error?: string }).error;
        if (error === "authorization_pending" || error === "slow_down") return { pending: true };
      }
      const body = await tokens<TokenBody>(res, "Kimi");
      return {
        credential: { access: body.access_token, refresh: body.refresh_token, expiresAt: expiresAt(body.expires_in), deviceId: login.deviceId },
        label: null,
      };
    },
    async refresh(env, c) {
      const res = await upstream(env, `${KIMI.auth}/api/oauth/token`, {
        ...form({ client_id: KIMI.client, grant_type: "refresh_token", refresh_token: c.refresh! }),
        headers: { ...form({}).headers, ...kimiHeaders(c.deviceId!) },
      });
      const body = await tokens<TokenBody>(res, "Kimi");
      return { ...c, access: body.access_token, refresh: body.refresh_token ?? c.refresh, expiresAt: expiresAt(body.expires_in) };
    },
    call(c, body) {
      return {
        urls: [KIMI.api],
        headers: { authorization: `Bearer ${c.access}`, "user-agent": "KimiCLI/0.1 ClaakeCode/0.1", ...kimiHeaders(c.deviceId!) },
        body: { ...body, stream: true },
      };
    },
  },

  mistral: {
    label: "Mistral",
    call(c, body) {
      return { urls: ["https://api.mistral.ai/v1/chat/completions"], headers: { authorization: `Bearer ${c.access}` }, body: { ...body, stream: true } };
    },
  },
};

// --- Storage ---

const owner = (user: User, provider: string) => `${user.id}:${provider}`;

function spec(provider: string | undefined): Spec {
  const found = provider ? SPECS[provider] : undefined;
  if (!found) throw new ApiError(404, "not_found", "Abonnement inconnu.");
  return found;
}

async function save(env: ProvidersEnv, user: User, provider: string, credential: Credential, label: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO provider_accounts (user_id, provider, label, secret, version, updated_at) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET label = excluded.label, secret = excluded.secret,
       version = provider_accounts.version + 1, updated_at = excluded.updated_at`,
  )
    .bind(user.id, provider, label, await seal(env, credential, owner(user, provider)), now())
    .run();
}

/** The stored credential, refreshed first when it expires within five minutes (or when `force`). */
async function credential(env: ProvidersEnv, user: User, provider: string, force = false): Promise<Credential> {
  const s = spec(provider);
  const read = () =>
    env.DB.prepare("SELECT secret, version FROM provider_accounts WHERE user_id = ? AND provider = ?")
      .bind(user.id, provider)
      .first<{ secret: string; version: number }>();
  const row = await read();
  if (!row) throw new ApiError(404, "not_connected", `${s.label} n'est pas connecté.`);
  const current = await unseal<Credential>(env, row.secret, owner(user, provider));
  if (!s.refresh || !current.refresh) return current;
  if (!force && (!current.expiresAt || current.expiresAt - REFRESH_SKEW_MS > now())) return current;

  let next: Credential;
  try {
    next = await s.refresh(env, current);
  } catch (err) {
    if (err instanceof ApiError && err.code === "provider_down") throw err;
    throw new ApiError(401, "provider_auth", `La connexion ${s.label} a expiré. Reconnecte ${s.label} dans les réglages.`);
  }
  const written = await env.DB.prepare(
    "UPDATE provider_accounts SET secret = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND provider = ? AND version = ?",
  )
    .bind(await seal(env, next, owner(user, provider)), now(), user.id, provider, row.version)
    .run();
  if (written.meta.changes) return next;
  // Another request refreshed first: use what it stored.
  const again = await read();
  return again ? unseal<Credential>(env, again.secret, owner(user, provider)) : next;
}

// --- Routes ---

async function startLogin(env: ProvidersEnv, user: User, provider: string) {
  const s = spec(provider);
  if (!s.start) throw new ApiError(400, "unsupported", `${s.label} se connecte avec une clé API.`);
  await env.DB.prepare("DELETE FROM provider_logins WHERE user_id = ? AND created_at < ?").bind(user.id, now() - LOGIN_MS).run();
  const login: Login = {};
  const started = await s.start(env, login);
  const id = `pl_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB.prepare("INSERT INTO provider_logins (id, user_id, provider, secret, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, user.id, provider, await seal(env, login, `${user.id}:login:${id}`), now())
    .run();
  return { loginId: id, ...started };
}

async function finishLogin(env: ProvidersEnv, user: User, provider: string, id: string, input: string) {
  const s = spec(provider);
  const row = await env.DB.prepare("SELECT secret, created_at FROM provider_logins WHERE id = ? AND user_id = ? AND provider = ?")
    .bind(id, user.id, provider)
    .first<{ secret: string; created_at: number }>();
  if (!row || row.created_at < now() - LOGIN_MS) throw new ApiError(410, "login_expired", "Cette connexion a expiré. Recommence.");
  const login = await unseal<Login>(env, row.secret, `${user.id}:login:${id}`);
  const finished = await s.finish!(env, login, input);
  if ("pending" in finished) return { pending: true };
  await save(env, user, provider, finished.credential, finished.label);
  await env.DB.prepare("DELETE FROM provider_logins WHERE id = ?").bind(id).run();
  return { connected: true, label: finished.label };
}

async function saveKey(env: ProvidersEnv, user: User, provider: string, key: string) {
  if (provider !== "mistral") throw new ApiError(400, "unsupported", "Cet abonnement se connecte avec ton compte.");
  const clean = key.trim();
  if (!clean) throw new ApiError(400, "invalid_field", "Colle ta clé API Mistral.");
  const res = await upstream(env, "https://api.mistral.ai/v1/models", { headers: { authorization: `Bearer ${clean}` } });
  if (!res.ok) throw new ApiError(400, "provider_refused", "Mistral refuse cette clé. Vérifie-la sur console.mistral.ai.");
  await save(env, user, provider, { access: clean }, null);
  return { connected: true, label: null };
}

/** Mistral's model list depends on the account, so it is read through the stored key. */
async function mistralModels(env: ProvidersEnv, user: User) {
  const c = await credential(env, user, "mistral");
  const res = await upstream(env, "https://api.mistral.ai/v1/models", { headers: { authorization: `Bearer ${c.access}` } });
  if (!res.ok) throw new ApiError(502, "provider_error", "Liste des modèles Mistral indisponible.");
  type Raw = { id: string; name?: string; max_context_length?: number; capabilities?: { completion_chat?: boolean; vision?: boolean }; deprecation?: string | null };
  const raw = ((await res.json()) as { data: Raw[] }).data;
  const seen = new Set<string>();
  return raw
    .filter((m) => m.capabilities?.completion_chat && !m.deprecation && /-latest$/.test(m.id))
    .filter((m) => !seen.has(m.id) && seen.add(m.id))
    .map((m) => ({ id: m.id, context: m.max_context_length ?? 0, images: Boolean(m.capabilities?.vision) }));
}

function upstreamError(label: string, status: number, detail: string): ApiError {
  let message = "";
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } | string; detail?: string; message?: string };
    message = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? parsed.detail ?? parsed.message ?? "";
  } catch {
    message = detail;
  }
  message = String(message).slice(0, 240);
  if (status === 401 || status === 403) return new ApiError(401, "provider_auth", `${label} refuse l'accès. Reconnecte ${label} dans les réglages.`);
  if (status === 429) return new ApiError(429, "provider_limit", `Limite de ton abonnement ${label} atteinte. Réessaie plus tard ou change de modèle.`);
  return new ApiError(502, "provider_error", message ? `${label} : ${message}` : `${label} a répondu ${status}.`);
}

/** Relays one model call and streams the provider's answer back unchanged. */
async function relay(env: ProvidersEnv, user: User, provider: string, request: Request): Promise<Response> {
  const s = spec(provider);
  const payload = await body<Record<string, unknown>>(request);
  let c = await credential(env, user, provider);
  let retried = false;
  for (;;) {
    const call = s.call(c, payload);
    let res: Response | null = null;
    for (const [i, url] of call.urls.entries()) {
      res = await upstream(env, url, { signal: request.signal, ...jsonPost(call.body, call.headers) });
      // Like the desktop, Antigravity falls back to its other endpoint when one refuses the project.
      if ((res.status === 403 || res.status === 404) && i < call.urls.length - 1) continue;
      break;
    }
    if (res!.status === 401 && s.refresh && c.refresh && !retried) {
      retried = true;
      c = await credential(env, user, provider, true);
      continue;
    }
    if (!res!.ok || !res!.body) throw upstreamError(s.label, res!.status, (await res!.text()).slice(0, 2000));
    return new Response(res!.body, {
      headers: { "content-type": res!.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-store" },
    });
  }
}

export async function handleProviders(request: Request, env: ProvidersEnv, user: User, parts: string[]): Promise<Response> {
  const method = request.method;
  const [provider, action, id] = parts;
  if (!provider && method === "GET") {
    const { results } = await env.DB.prepare("SELECT provider, label, updated_at FROM provider_accounts WHERE user_id = ? ORDER BY provider")
      .bind(user.id)
      .all<{ provider: string; label: string | null; updated_at: number }>();
    return ok({ accounts: results.filter((r) => SPECS[r.provider]).map((r) => ({ provider: r.provider, label: r.label, updatedAtMs: r.updated_at })) });
  }
  if (provider && !action && method === "DELETE") {
    spec(provider);
    await env.DB.prepare("DELETE FROM provider_accounts WHERE user_id = ? AND provider = ?").bind(user.id, provider).run();
    return ok({ deleted: provider });
  }
  if (action === "login" && !id && method === "POST") return ok(await startLogin(env, user, provider));
  if (action === "login" && id && method === "POST") {
    const { input } = await body<{ input?: string }>(request);
    return ok(await finishLogin(env, user, provider, id, typeof input === "string" ? input : ""));
  }
  if (action === "key" && method === "PUT") {
    const { key } = await body<{ key?: string }>(request);
    return ok(await saveKey(env, user, provider, typeof key === "string" ? key : ""));
  }
  if (action === "models" && provider === "mistral" && method === "GET") return ok({ models: await mistralModels(env, user) });
  if (action === "chat" && method === "POST") return relay(env, user, provider, request);
  throw new ApiError(404, "not_found", "Introuvable.");
}
