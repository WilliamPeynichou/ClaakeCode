/// <reference types="@cloudflare/workers-types" />
// Claake Ask API (/v1): GitHub sign-in, projects, conversations, messages and documents, stored in D1.
// The phone calls OpenRouter itself, with the user's own key. Subscriptions (Claude, ChatGPT…) go through
// /v1/providers, which keeps their credentials encrypted and relays the model calls.
import { handleProviders, type ProvidersEnv } from "./providers";

export interface AskEnv extends ProvidersEnv {
  DB: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated GitHub logins allowed in the beta (a secret, so testers stay out of the repo). */
  ALLOWED_GITHUB_LOGINS?: string;
  /** Overridden by the tests, which run a fake GitHub. */
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
}

const SESSION_COOKIE = "claake_session";
const STATE_COOKIE = "claake_oauth_state";
const SESSION_DAYS = 30;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** D1 rows hold at most ~2 MB, so documents are stored in chunks. */
const CHUNK_BYTES = 1_500_000;
const LIST_LIMIT = 200;

export type User = { id: string; login: string; name: string | null; avatarUrl: string | null };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const notFound = () => new ApiError(404, "not_found", "Introuvable.");

const now = () => Date.now();
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

function redirect(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

export async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(400, "invalid_json", "Corps JSON invalide.");
  }
}

function text(value: unknown, max: number, field: string, required = false): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (required && !s) throw new ApiError(400, "invalid_field", `${field} est requis.`);
  if (s.length > max) throw new ApiError(400, "invalid_field", `${field} est trop long.`);
  return s;
}

/* ── GitHub sign-in ── */

function allowed(env: AskEnv, login: string): boolean {
  const list = (env.ALLOWED_GITHUB_LOGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(login.toLowerCase());
}

function startSignIn(env: AskEnv, url: URL): Response {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return redirect("/?auth_error=not_configured");
  const state = randomToken(16);
  const authorize = new URL("/login/oauth/authorize", env.GITHUB_OAUTH_URL || "https://github.com");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${url.origin}/v1/auth/github/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");
  return redirect(authorize.toString(), [cookie(STATE_COOKIE, state, 600)]);
}

async function finishSignIn(env: AskEnv, request: Request, url: URL): Promise<Response> {
  const clearState = cookie(STATE_COOKIE, "", 0);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || state !== cookies(request)[STATE_COOKIE]) return redirect("/?auth_error=state", [clearState]);

  const tokenResponse = await fetch(new URL("/login/oauth/access_token", env.GITHUB_OAUTH_URL || "https://github.com"), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/v1/auth/github/callback`,
    }),
  });
  const token = ((await tokenResponse.json().catch(() => ({}))) as { access_token?: string }).access_token;
  if (!token) return redirect("/?auth_error=github", [clearState]);

  const userResponse = await fetch(new URL("/user", env.GITHUB_API_URL || "https://api.github.com"), {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "claake-ask" },
  });
  if (!userResponse.ok) return redirect("/?auth_error=github", [clearState]);
  const gh = (await userResponse.json()) as { id: number; login: string; name?: string | null; avatar_url?: string | null };
  // The GitHub token is only used to read the profile: it is not stored.
  if (!allowed(env, gh.login)) return redirect("/?auth_error=not_allowed", [clearState]);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE github_id = ?").bind(gh.id).first<{ id: string }>();
  const userId = existing?.id ?? newId("usr");
  await env.DB.prepare(
    `INSERT INTO users (id, github_id, login, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
  )
    .bind(userId, gh.id, gh.login, gh.name ?? null, gh.avatar_url ?? null, now())
    .run();

  const session = randomToken();
  const expires = now() + SESSION_DAYS * 86_400_000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(session), userId, expires),
  ]);
  return redirect("/?tab=ask", [clearState, cookie(SESSION_COOKIE, session, SESSION_DAYS * 86_400)]);
}

async function currentUser(env: AskEnv, request: Request): Promise<User | null> {
  const session = cookies(request)[SESSION_COOKIE];
  if (!session) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.login, u.name, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(session), now())
    .first<{ id: string; login: string; name: string | null; avatar_url: string | null }>();
  // Testers removed from the allowlist lose access at once.
  if (!row || !allowed(env, row.login)) return null;
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url };
}

async function signOut(env: AskEnv, request: Request): Promise<Response> {
  const session = cookies(request)[SESSION_COOKIE];
  if (session) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(session)).run();
  const response = ok({ signedOut: true });
  response.headers.append("set-cookie", cookie(SESSION_COOKIE, "", 0));
  return response;
}

/* ── Data ── */

type ProjectRow = { id: string; name: string; instructions: string; created_at: number; updated_at: number; conversations?: number; documents?: number };
type ConversationRow = { id: string; project_id: string | null; title: string; model: string | null; created_at: number; updated_at: number };
type MessageRow = { id: string; role: string; text: string; attachments: string; model: string | null; created_at: number };
type DocumentRow = { id: string; project_id: string | null; conversation_id: string | null; name: string; media_type: string; size: number; created_at: number };

const project = (r: ProjectRow) => ({
  id: r.id, name: r.name, instructions: r.instructions, createdAtMs: r.created_at, updatedAtMs: r.updated_at,
  conversationCount: r.conversations ?? 0, documentCount: r.documents ?? 0,
});
const conversation = (r: ConversationRow) => ({
  id: r.id, projectId: r.project_id, title: r.title, model: r.model, createdAtMs: r.created_at, updatedAtMs: r.updated_at,
});
const message = (r: MessageRow) => ({
  id: r.id, role: r.role, text: r.text, attachments: JSON.parse(r.attachments || "[]"), model: r.model, createdAtMs: r.created_at,
});
const documentOut = (r: DocumentRow) => ({
  id: r.id, projectId: r.project_id, conversationId: r.conversation_id, name: r.name, mediaType: r.media_type, size: r.size, createdAtMs: r.created_at,
});

async function ownProject(env: AskEnv, user: User, id: string): Promise<ProjectRow> {
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").bind(id, user.id).first<ProjectRow>();
  if (!row) throw notFound();
  return row;
}

async function ownConversation(env: AskEnv, user: User, id: string): Promise<ConversationRow> {
  const row = await env.DB.prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?").bind(id, user.id).first<ConversationRow>();
  if (!row) throw notFound();
  return row;
}

async function ownDocument(env: AskEnv, user: User, id: string): Promise<DocumentRow> {
  const row = await env.DB.prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?").bind(id, user.id).first<DocumentRow>();
  if (!row) throw notFound();
  return row;
}

async function listProjects(env: AskEnv, user: User) {
  const { results } = await env.DB.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS conversations,
       (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS documents
     FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC LIMIT ?`,
  ).bind(user.id, LIST_LIMIT).all<ProjectRow>();
  return results.map(project);
}

async function projectDetail(env: AskEnv, user: User, id: string) {
  const row = await ownProject(env, user, id);
  const [docs, convs] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM documents WHERE project_id = ? ORDER BY created_at DESC").bind(id),
    env.DB.prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?").bind(id, LIST_LIMIT),
  ]);
  const documents = (docs.results as DocumentRow[]).map(documentOut);
  const conversations = (convs.results as ConversationRow[]).map(conversation);
  return { project: project({ ...row, conversations: conversations.length, documents: documents.length }), documents, conversations };
}

async function createProject(env: AskEnv, user: User, input: { name?: unknown; instructions?: unknown }) {
  const row: ProjectRow = {
    id: newId("prj"), name: text(input.name, 80, "Le nom", true), instructions: text(input.instructions, 20_000, "Les instructions"),
    created_at: now(), updated_at: now(),
  };
  await env.DB.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, user.id, row.name, row.instructions, row.created_at, row.updated_at).run();
  return project(row);
}

async function updateProject(env: AskEnv, user: User, id: string, input: { name?: unknown; instructions?: unknown }) {
  const row = await ownProject(env, user, id);
  const next = {
    ...row,
    name: input.name === undefined ? row.name : text(input.name, 80, "Le nom", true),
    instructions: input.instructions === undefined ? row.instructions : text(input.instructions, 20_000, "Les instructions"),
    updated_at: now(),
  };
  await env.DB.prepare("UPDATE projects SET name = ?, instructions = ?, updated_at = ? WHERE id = ?")
    .bind(next.name, next.instructions, next.updated_at, id).run();
  return project(next);
}

async function listConversations(env: AskEnv, user: User, projectId: string | null) {
  const filter = projectId === "none" ? "AND project_id IS NULL" : projectId ? "AND project_id = ?" : "";
  const binds: unknown[] = [user.id, ...(projectId && projectId !== "none" ? [projectId] : []), LIST_LIMIT];
  const { results } = await env.DB.prepare(
    `SELECT * FROM conversations WHERE user_id = ? ${filter} ORDER BY updated_at DESC LIMIT ?`,
  ).bind(...binds).all<ConversationRow>();
  return results.map(conversation);
}

async function createConversation(env: AskEnv, user: User, input: { projectId?: unknown; title?: unknown; model?: unknown }) {
  const projectId = typeof input.projectId === "string" && input.projectId ? input.projectId : null;
  if (projectId) await ownProject(env, user, projectId);
  const row: ConversationRow = {
    id: newId("cnv"), project_id: projectId, title: text(input.title, 120, "Le titre") || "Nouvelle conversation",
    model: text(input.model, 200, "Le modèle") || null, created_at: now(), updated_at: now(),
  };
  await env.DB.prepare("INSERT INTO conversations (id, user_id, project_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, user.id, row.project_id, row.title, row.model, row.created_at, row.updated_at).run();
  return conversation(row);
}

async function conversationDetail(env: AskEnv, user: User, id: string) {
  const row = await ownConversation(env, user, id);
  const { results } = await env.DB.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid").bind(id).all<MessageRow>();
  return { conversation: conversation(row), messages: results.map(message) };
}

async function updateConversation(env: AskEnv, user: User, id: string, input: { title?: unknown; model?: unknown }) {
  const row = await ownConversation(env, user, id);
  const next = {
    ...row,
    title: input.title === undefined ? row.title : text(input.title, 120, "Le titre", true),
    model: input.model === undefined ? row.model : text(input.model, 200, "Le modèle") || null,
  };
  await env.DB.prepare("UPDATE conversations SET title = ?, model = ? WHERE id = ?").bind(next.title, next.model, id).run();
  return conversation(next);
}

type IncomingMessage = { role?: unknown; text?: unknown; attachments?: unknown; model?: unknown };

async function appendMessages(env: AskEnv, user: User, id: string, input: { messages?: unknown }) {
  const row = await ownConversation(env, user, id);
  const items = Array.isArray(input.messages) ? (input.messages as IncomingMessage[]) : [];
  if (items.length === 0 || items.length > 20) throw new ApiError(400, "invalid_field", "Entre 1 et 20 messages.");
  const at = now();
  const saved: MessageRow[] = [];
  for (const [i, item] of items.entries()) {
    if (item.role !== "user" && item.role !== "assistant") throw new ApiError(400, "invalid_field", "Rôle inconnu.");
    const ids = Array.isArray(item.attachments) ? item.attachments.filter((a): a is string => typeof a === "string").slice(0, 10) : [];
    const refs = [];
    for (const docId of ids) {
      const doc = await ownDocument(env, user, docId);
      refs.push({ id: doc.id, name: doc.name, mediaType: doc.media_type, size: doc.size });
    }
    saved.push({
      id: newId("msg"), role: item.role, text: text(item.text, 200_000, "Le message"), attachments: JSON.stringify(refs),
      model: text(item.model, 200, "Le modèle") || null, created_at: at + i,
    });
  }
  await env.DB.batch([
    ...saved.map((m) =>
      env.DB.prepare("INSERT INTO messages (id, conversation_id, role, text, attachments, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(m.id, id, m.role, m.text, m.attachments, m.model, m.created_at),
    ),
    env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(at, id),
    ...(row.project_id ? [env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(at, row.project_id)] : []),
  ]);
  return saved.map(message);
}

/** The body is the file in base64: the phone needs base64 for the models anyway, and the Worker never decodes it. */
async function uploadDocument(env: AskEnv, user: User, request: Request, url: URL) {
  const projectId = url.searchParams.get("projectId") || null;
  const conversationId = url.searchParams.get("conversationId") || null;
  if (!projectId === !conversationId) throw new ApiError(400, "invalid_field", "Un projet ou une conversation est requis.");
  if (projectId) await ownProject(env, user, projectId);
  if (conversationId) await ownConversation(env, user, conversationId);
  const name = text(url.searchParams.get("name"), 200, "Le nom", true);
  const mediaType = text(url.searchParams.get("type"), 120, "Le type") || "application/octet-stream";
  const base64 = (await request.text()).trim();
  const size = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (size <= 0) throw new ApiError(400, "invalid_field", "Fichier vide.");
  if (size > MAX_DOCUMENT_BYTES) throw new ApiError(413, "too_large", "Fichier trop lourd (10 Mo maximum).");
  const row: DocumentRow = { id: newId("doc"), project_id: projectId, conversation_id: conversationId, name, media_type: mediaType, size, created_at: now() };
  const chunks = [];
  for (let i = 0; i * CHUNK_BYTES < base64.length; i += 1) chunks.push(base64.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO documents (id, user_id, project_id, conversation_id, name, media_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(row.id, user.id, row.project_id, row.conversation_id, row.name, row.media_type, row.size, row.created_at),
    ...chunks.map((data, i) => env.DB.prepare("INSERT INTO document_chunks (document_id, idx, data) VALUES (?, ?, ?)").bind(row.id, i, data)),
    ...(projectId ? [env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(row.created_at, projectId)] : []),
  ]);
  return documentOut(row);
}

async function documentContent(env: AskEnv, user: User, id: string): Promise<Response> {
  const doc = await ownDocument(env, user, id);
  const { results } = await env.DB.prepare("SELECT data FROM document_chunks WHERE document_id = ? ORDER BY idx").bind(id).all<{ data: string }>();
  return new Response(results.map((r) => r.data).join(""), {
    headers: { "content-type": "text/plain; charset=utf-8", "x-media-type": doc.media_type, "cache-control": "private, max-age=86400" },
  });
}

/* ── Router ── */

export async function handleAsk(request: Request, env: AskEnv, url: URL): Promise<Response> {
  const method = request.method;
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "v1"
  try {
    if (parts[0] === "auth") {
      if (method === "GET" && parts[1] === "github" && parts[2] === "start") return startSignIn(env, url);
      if (method === "GET" && parts[1] === "github" && parts[2] === "callback") return await finishSignIn(env, request, url);
    }
    // Cookies are SameSite=Lax; the Origin check also covers older browsers.
    if (method !== "GET" && method !== "HEAD" && request.headers.get("origin") !== url.origin) {
      throw new ApiError(403, "bad_origin", "Origine refusée.");
    }
    if (method === "POST" && parts[0] === "auth" && parts[1] === "logout") return await signOut(env, request);

    const user = await currentUser(env, request);
    if (!user) throw new ApiError(401, "unauthenticated", "Connecte-toi avec GitHub.");
    const [resource, id, sub] = parts;

    if (resource === "me" && method === "GET") return ok({ user });
    if (resource === "providers") return await handleProviders(request, env, user, parts.slice(1));

    if (resource === "projects") {
      if (!id && method === "GET") return ok({ projects: await listProjects(env, user) });
      if (!id && method === "POST") return ok({ project: await createProject(env, user, await body(request)) }, 201);
      if (id && !sub && method === "GET") return ok(await projectDetail(env, user, id));
      if (id && !sub && method === "PATCH") return ok({ project: await updateProject(env, user, id, await body(request)) });
      if (id && !sub && method === "DELETE") {
        await ownProject(env, user, id);
        await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
        return ok({ deleted: id });
      }
    }

    if (resource === "conversations") {
      if (!id && method === "GET") return ok({ conversations: await listConversations(env, user, url.searchParams.get("projectId")) });
      if (!id && method === "POST") return ok({ conversation: await createConversation(env, user, await body(request)) }, 201);
      if (id && !sub && method === "GET") return ok(await conversationDetail(env, user, id));
      if (id && !sub && method === "PATCH") return ok({ conversation: await updateConversation(env, user, id, await body(request)) });
      if (id && !sub && method === "DELETE") {
        await ownConversation(env, user, id);
        await env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(id).run();
        return ok({ deleted: id });
      }
      if (id && sub === "messages" && method === "POST") return ok({ messages: await appendMessages(env, user, id, await body(request)) }, 201);
    }

    if (resource === "documents") {
      if (!id && method === "POST") return ok({ document: await uploadDocument(env, user, request, url) }, 201);
      if (id && sub === "content" && method === "GET") return await documentContent(env, user, id);
      if (id && !sub && method === "DELETE") {
        await ownDocument(env, user, id);
        await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
        return ok({ deleted: id });
      }
    }
    throw notFound();
  } catch (err) {
    if (err instanceof ApiError) return fail(err.status, err.code, err.message);
    console.error("ask api error", String(err));
    return fail(500, "server_error", "Erreur du serveur.");
  }
}
