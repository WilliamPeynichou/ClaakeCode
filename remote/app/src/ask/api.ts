// Client for the Claake Ask API (/v1 on the same origin): the session is an HttpOnly cookie.

export type AskUser = { id: string; login: string; name: string | null; avatarUrl: string | null };
export type Project = {
  id: string;
  name: string;
  instructions: string;
  createdAtMs: number;
  updatedAtMs: number;
  conversationCount: number;
  documentCount: number;
};
export type AskConversation = { id: string; projectId: string | null; title: string; model: string | null; createdAtMs: number; updatedAtMs: number };
export type DocumentRef = { id: string; name: string; mediaType: string; size: number };
export type AskDocument = DocumentRef & { projectId: string | null; conversationId: string | null; createdAtMs: number };
export type AskMessage = { id: string; role: "user" | "assistant"; text: string; attachments: DocumentRef[]; model: string | null; createdAtMs: number };

export type ProviderAccount = { provider: string; label: string | null; updatedAtMs: number };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, data?: unknown, raw?: { body: string; type: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/v1${path}`, {
      method,
      credentials: "same-origin",
      headers: raw ? { "content-type": "text/plain" } : data === undefined ? undefined : { "content-type": "application/json" },
      body: raw ? raw.body : data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    throw new ApiError(0, "offline", "Pas de connexion Internet.");
  }
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code: string; message: string } } | null;
  if (!res.ok || !json?.data) throw new ApiError(res.status, json?.error?.code ?? "server_error", json?.error?.message ?? "Erreur du serveur.");
  return json.data;
}

// Document content never changes: keep it for the session, the model needs it on every message.
const contents = new Map<string, Promise<string>>();

export const askApi = {
  me: () => call<{ user: AskUser }>("GET", "/me").then((d) => d.user),
  logout: () => call<{ signedOut: boolean }>("POST", "/auth/logout"),

  projects: () => call<{ projects: Project[] }>("GET", "/projects").then((d) => d.projects),
  project: (id: string) => call<{ project: Project; documents: AskDocument[]; conversations: AskConversation[] }>("GET", `/projects/${id}`),
  createProject: (name: string, instructions = "") =>
    call<{ project: Project }>("POST", "/projects", { name, instructions }).then((d) => d.project),
  updateProject: (id: string, patch: { name?: string; instructions?: string }) =>
    call<{ project: Project }>("PATCH", `/projects/${id}`, patch).then((d) => d.project),
  deleteProject: (id: string) => call("DELETE", `/projects/${id}`),

  providers: () => call<{ accounts: ProviderAccount[] }>("GET", "/providers").then((d) => d.accounts),
  startProviderLogin: (provider: string) =>
    call<{ loginId: string; url: string; userCode?: string }>("POST", `/providers/${provider}/login`),
  finishProviderLogin: (provider: string, loginId: string, input = "") =>
    call<{ connected?: boolean; pending?: boolean; label?: string | null }>("POST", `/providers/${provider}/login/${loginId}`, { input }),
  saveProviderKey: (provider: string, key: string) => call<{ connected: boolean }>("PUT", `/providers/${provider}/key`, { key }),
  disconnectProvider: (provider: string) => call("DELETE", `/providers/${provider}`),
  mistralModels: () =>
    call<{ models: { id: string; context: number; images: boolean }[] }>("GET", "/providers/mistral/models").then((d) => d.models),

  conversations: () => call<{ conversations: AskConversation[] }>("GET", "/conversations").then((d) => d.conversations),
  conversation: (id: string) => call<{ conversation: AskConversation; messages: AskMessage[] }>("GET", `/conversations/${id}`),
  createConversation: (input: { projectId?: string | null; title?: string; model?: string | null }) =>
    call<{ conversation: AskConversation }>("POST", "/conversations", input).then((d) => d.conversation),
  updateConversation: (id: string, patch: { title?: string; model?: string | null }) =>
    call<{ conversation: AskConversation }>("PATCH", `/conversations/${id}`, patch).then((d) => d.conversation),
  deleteConversation: (id: string) => call("DELETE", `/conversations/${id}`),
  appendMessages: (id: string, messages: { role: "user" | "assistant"; text: string; attachments?: string[]; model?: string | null }[]) =>
    call<{ messages: AskMessage[] }>("POST", `/conversations/${id}/messages`, { messages }).then((d) => d.messages),

  uploadDocument: (target: { projectId: string } | { conversationId: string }, file: { name: string; mediaType: string; base64: string }) => {
    const query = new URLSearchParams({ ...target, name: file.name, type: file.mediaType });
    return call<{ document: AskDocument }>("POST", `/documents?${query}`, undefined, { body: file.base64, type: file.mediaType }).then((d) => {
      contents.set(d.document.id, Promise.resolve(file.base64));
      return d.document;
    });
  },
  deleteDocument: (id: string) => call("DELETE", `/documents/${id}`),
  /** The file in base64. */
  documentContent(id: string): Promise<string> {
    let pending = contents.get(id);
    if (!pending) {
      pending = fetch(`/v1/documents/${id}/content`, { credentials: "same-origin" }).then((res) => {
        if (!res.ok) throw new ApiError(res.status, "not_found", "Document introuvable.");
        return res.text();
      });
      pending.catch(() => contents.delete(id));
      contents.set(id, pending);
    }
    return pending;
  },
};

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToText(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`;
}
