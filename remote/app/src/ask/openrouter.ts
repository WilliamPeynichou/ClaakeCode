// OpenRouter from the phone: each tester connects their own account (PKCE), the key never leaves the device.

const KEY = "claake.openrouter.key";
const VERIFIER = "claake.openrouter.verifier";
const MODEL = "claake.ask.model";
const MODELS_CACHE = "claake.openrouter.models.v1";
const API = "https://openrouter.ai/api/v1";

export type OrModel = { id: string; name: string; free: boolean; images: boolean; files: boolean; context: number };

export const getKey = () => localStorage.getItem(KEY);
export const setKey = (key: string) => localStorage.setItem(KEY, key.trim());
export const clearKey = () => localStorage.removeItem(KEY);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Opens OpenRouter's consent page; it comes back to /?openrouter=callback&code=… */
export async function connect(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  localStorage.setItem(VERIFIER, verifier);
  const callback = `${location.origin}/?openrouter=callback`;
  location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
}

/** Trades the code from the callback for a key. */
export async function finishConnect(code: string): Promise<void> {
  const verifier = localStorage.getItem(VERIFIER);
  localStorage.removeItem(VERIFIER);
  if (!verifier) throw new Error("La connexion OpenRouter a expiré. Recommence.");
  const res = await fetch(`${API}/auth/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  const data = (await res.json().catch(() => ({}))) as { key?: string };
  if (!res.ok || !data.key) throw new Error("OpenRouter a refusé la connexion. Recommence.");
  setKey(data.key);
}

type RawModel = {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[] };
};

export async function listModels(): Promise<OrModel[]> {
  const cached = JSON.parse(localStorage.getItem(MODELS_CACHE) || "null") as { at: number; models: OrModel[] } | null;
  if (cached && Date.now() - cached.at < 86_400_000) return cached.models;
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error("Liste des modèles indisponible.");
  const raw = ((await res.json()) as { data: RawModel[] }).data;
  const models = raw
    .map((m) => ({
      id: m.id,
      name: m.name.replace(/\s*\(free\)\s*$/i, ""),
      free: m.pricing?.prompt === "0" && m.pricing?.completion === "0",
      images: Boolean(m.architecture?.input_modalities?.includes("image")),
      files: Boolean(m.architecture?.input_modalities?.includes("file")),
      context: m.context_length ?? 0,
    }))
    .sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name));
  localStorage.setItem(MODELS_CACHE, JSON.stringify({ at: Date.now(), models }));
  return models;
}

// Preferred free models, in order; the free list changes often, so the first free model is the fallback.
const PREFERRED = [/deepseek.*chat/i, /llama-3\.3-70b/i, /gemini.*flash/i, /qwen/i, /mistral/i];

export function defaultModel(models: OrModel[]): OrModel | undefined {
  const saved = models.find((m) => m.id === localStorage.getItem(MODEL));
  if (saved) return saved;
  const free = models.filter((m) => m.free);
  for (const pattern of PREFERRED) {
    const hit = free.find((m) => pattern.test(m.id));
    if (hit) return hit;
  }
  return free[0] ?? models[0];
}

export const saveDefaultModel = (id: string) => localStorage.setItem(MODEL, id);

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

/** Streams a completion; resolves with the full text. */
export async function streamChat({ key, model, messages, signal, onDelta }: {
  key: string;
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta(text: string): void;
}): Promise<string> {
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "HTTP-Referer": location.origin,
      "X-Title": "Claake Code",
    },
    // PDFs are parsed with the free text engine.
    body: JSON.stringify({ model, messages, stream: true, plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }] }),
  });
  if (!res.ok || !res.body) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (res.status === 401) throw new Error("Ta clé OpenRouter n'est plus valide. Reconnecte OpenRouter dans les réglages.");
    if (res.status === 402) throw new Error("Crédits OpenRouter insuffisants. Choisis un modèle gratuit.");
    if (res.status === 429) throw new Error("Limite du modèle gratuit atteinte. Réessaie plus tard ou change de modèle.");
    throw new Error(detail?.error?.message || `OpenRouter a répondu ${res.status}.`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue; // ": OPENROUTER PROCESSING" keep-alives
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return full;
      const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
      if (chunk.error) throw new Error(chunk.error.message || "Erreur du modèle.");
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta(full);
      }
    }
  }
  return full;
}
