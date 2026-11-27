// Every model the Ask chat can use: OpenRouter (the phone's own key) and the subscriptions connected in
// the settings (Claude, ChatGPT, Gemini, Kimi, Mistral), which the Worker relays with the stored credentials.
// Subscription models come from the desktop catalog (models.json), so both apps offer the same list.
import catalog from "../../../../models.json";
import { askApi, type ProviderAccount } from "./api";
import { getKey, listModels, streamChat, type ChatMessage, type ContentPart, type OrModel } from "./openrouter";

export type Subscription = "anthropic" | "openai" | "google" | "kimi" | "mistral";
export type Source = "openrouter" | Subscription;
export type Model = OrModel & { source: Source; thinking?: string; maxOutput?: number };

export const SUBSCRIPTIONS: { id: Subscription; label: string; plan: string; signIn: "paste" | "device" | "key" }[] = [
  { id: "anthropic", label: "Claude", plan: "Pro ou Max", signIn: "paste" },
  { id: "openai", label: "ChatGPT", plan: "Plus ou Pro", signIn: "paste" },
  { id: "google", label: "Gemini", plan: "Compte Google", signIn: "paste" },
  { id: "kimi", label: "Kimi", plan: "Kimi Code", signIn: "device" },
  { id: "mistral", label: "Mistral", plan: "Clé API", signIn: "key" },
];
export const subscriptionLabel = (id: string) => SUBSCRIPTIONS.find((s) => s.id === id)?.label ?? id;

type CatalogModel = { provider: string; id: string; label: string; contextWindow: number; maxOutput: number; defaultThinking?: string; supportsImages?: boolean };

const SUBSCRIPTION_ID = /^(anthropic|openai|google|kimi|mistral):(.+)$/;
/** Subscription models are stored as "provider:model"; OpenRouter ids ("vendor/model") never match. */
export const sourceOf = (id: string | null | undefined): Source => (SUBSCRIPTION_ID.exec(id ?? "")?.[1] as Subscription) ?? "openrouter";

let accounts: Promise<ProviderAccount[]> | null = null;
/** Fires when a subscription is connected or removed, so open chats reload their models. */
export const accountsChanged = new EventTarget();
/** The connected subscriptions, cached until `refreshAccounts`. */
export const connectedAccounts = () => (accounts ??= askApi.providers().catch(() => []));
export function refreshAccounts() {
  accounts = null;
  accountsChanged.dispatchEvent(new Event("change"));
  return connectedAccounts();
}

/** OpenRouter's list when a key is set, then each connected subscription's models. */
export async function allModels(): Promise<Model[]> {
  const connected = new Set((await connectedAccounts()).map((a) => a.provider));
  const own: Model[] = (catalog.models as CatalogModel[])
    .filter((m) => connected.has(m.provider))
    .map((m) => ({
      id: `${m.provider}:${m.id}`,
      name: m.label,
      free: false,
      images: m.supportsImages ?? m.provider !== "kimi",
      files: m.provider !== "kimi",
      context: m.contextWindow,
      source: m.provider as Subscription,
      thinking: m.defaultThinking,
      maxOutput: m.maxOutput,
    }));
  if (connected.has("mistral")) {
    const mistral = await askApi.mistralModels().catch(() => []);
    own.push(...mistral.map((m) => ({
      id: `mistral:${m.id}`,
      name: m.id.replace(/-latest$/, "").replace(/(^|-)(\w)/g, (_, dash: string, c: string) => `${dash ? " " : ""}${c.toUpperCase()}`),
      free: false,
      images: m.images,
      files: false,
      context: m.context,
      source: "mistral" as const,
    })));
  }
  const openrouter: Model[] = getKey() ? (await listModels().catch(() => [])).map((m) => ({ ...m, source: "openrouter" as const })) : [];
  return [...own, ...openrouter];
}

// --- Request bodies, from the OpenAI-style messages built by context.ts ---

const dataUrl = (url: string) => {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : null;
};
const parts = (content: ChatMessage["content"]): ContentPart[] => (typeof content === "string" ? [{ type: "text", text: content }] : content);
const textOf = (content: ChatMessage["content"]) => parts(content).map((p) => (p.type === "text" ? p.text : "")).join("\n");
const unread = (name: string) => ({ type: "text" as const, text: `[Le document ${name} n'a pas pu être lu par ce modèle.]` });

function split(messages: ChatMessage[]) {
  return { system: messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n"), turns: messages.filter((m) => m.role !== "system") };
}

function anthropicBody(model: Model, name: string, messages: ChatMessage[]) {
  const { system, turns } = split(messages);
  return {
    model: name,
    max_tokens: Math.min(model.maxOutput ?? 16_000, 32_000),
    system,
    messages: turns.map((m) => ({
      role: m.role,
      content: parts(m.content).map((p) => {
        if (p.type === "text") return { type: "text", text: p.text };
        const data = dataUrl(p.type === "image_url" ? p.image_url.url : p.file.file_data);
        if (!data) return { type: "text", text: "" };
        return p.type === "image_url"
          ? { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.data } }
          : { type: "document", source: { type: "base64", media_type: "application/pdf", data: data.data } };
      }),
    })),
  };
}

function openaiBody(model: Model, name: string, messages: ChatMessage[]) {
  const { system, turns } = split(messages);
  return {
    model: name,
    instructions: system,
    input: turns.map((m) =>
      m.role === "assistant"
        ? { type: "message", role: "assistant", content: [{ type: "output_text", text: textOf(m.content) }] }
        : {
            type: "message",
            role: "user",
            content: parts(m.content).map((p) =>
              p.type === "text"
                ? { type: "input_text", text: p.text }
                : p.type === "image_url"
                  ? { type: "input_image", image_url: p.image_url.url }
                  : { type: "input_file", filename: p.file.filename, file_data: p.file.file_data },
            ),
          },
    ),
    reasoning: { effort: model.thinking === "low" ? "low" : "medium" },
  };
}

function googleBody(model: Model, name: string, messages: ChatMessage[]) {
  const { system, turns } = split(messages);
  const level = model.thinking === "low" || model.thinking === "medium" ? model.thinking : "high";
  return {
    model: name,
    request: {
      contents: turns.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: parts(m.content).map((p) => {
          if (p.type === "text") return { text: p.text };
          const data = dataUrl(p.type === "image_url" ? p.image_url.url : p.file.file_data);
          return data ? { inlineData: { mimeType: data.mediaType, data: data.data } } : { text: "" };
        }),
      })),
      systemInstruction: { role: "user", parts: [{ text: system }] },
      generationConfig: { temperature: 1, topP: 0.95, topK: 64, thinkingConfig: { includeThoughts: false, thinkingLevel: level } },
    },
  };
}

/** Kimi and Mistral speak the OpenAI chat format; PDFs are not read there. */
function chatBody(model: Model, name: string, messages: ChatMessage[]) {
  return {
    model: name,
    messages: messages.map((m) =>
      typeof m.content === "string"
        ? m
        : { ...m, content: m.content.map((p) => (p.type === "file" ? unread(p.file.filename) : p.type === "image_url" && !model.images ? unread("image") : p)) },
    ),
  };
}

// --- Streaming ---

/** Calls `onData(event, data)` for each server-sent event; stops early when it returns true. */
async function readEvents(res: Response, onData: (event: string, data: string) => boolean | void): Promise<void> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let event = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        if (onData(event, line.slice(5).trim())) {
          void reader.cancel();
          return;
        }
      } else if (!line) event = "";
    }
  }
}

type Delta = (data: any, event: string) => string | undefined;
const DELTAS: Record<Subscription, Delta> = {
  anthropic: (d) => (d.type === "content_block_delta" && d.delta?.type === "text_delta" ? d.delta.text : undefined),
  openai: (d) => (d.type === "response.output_text.delta" ? d.delta : undefined),
  google: (d) =>
    ((d.response ?? d).candidates?.[0]?.content?.parts as { text?: string; thought?: boolean }[] | undefined)
      ?.filter((p) => !p.thought && p.text)
      .map((p) => p.text)
      .join(""),
  kimi: (d) => d.choices?.[0]?.delta?.content,
  mistral: (d) => d.choices?.[0]?.delta?.content,
};

function streamError(source: Subscription, d: any): string | undefined {
  if (source === "anthropic" && d.type === "error") return d.error?.message;
  if (source === "openai" && (d.type === "error" || d.type === "response.failed")) return d.error?.message ?? d.response?.error?.message ?? d.message;
  return d.error ? (typeof d.error === "string" ? d.error : d.error.message) : undefined;
}

/** Streams a completion from the model's source; resolves with the full text. */
export async function streamModel({ model, messages, signal, onDelta }: {
  model: Model;
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta(text: string): void;
}): Promise<string> {
  if (model.source === "openrouter") {
    const key = getKey();
    if (!key) throw new Error("Connecte OpenRouter dans les réglages pour utiliser ce modèle.");
    return streamChat({ key, model: model.id, messages, signal, onDelta });
  }
  const source = model.source;
  const name = model.id.slice(source.length + 1);
  const body =
    source === "anthropic" ? anthropicBody(model, name, messages)
    : source === "openai" ? openaiBody(model, name, messages)
    : source === "google" ? googleBody(model, name, messages)
    : chatBody(model, name, messages);
  const res = await fetch(`/v1/providers/${source}/chat`, {
    method: "POST",
    signal,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(detail?.error?.message || `${subscriptionLabel(source)} a répondu ${res.status}.`);
  }
  let full = "";
  let failure: string | undefined;
  await readEvents(res, (event, raw) => {
    if (raw === "[DONE]") return true;
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    failure = streamError(source, data);
    if (failure) return true;
    const delta = DELTAS[source](data, event);
    if (delta) {
      full += delta;
      onDelta(full);
    }
  });
  if (failure) throw new Error(`${subscriptionLabel(source)} : ${failure}`);
  return full;
}
