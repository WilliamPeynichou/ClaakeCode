import { useSyncExternalStore } from "react";
import type {
  AgentMode,
  MistralModel,
  ModeModelSettings,
  ModelRef,
  OpenRouterModel,
  ThinkingLevel,
} from "../types";

export type ModelId = string;
export type ProviderId = "anthropic" | "openai" | "google" | "xai" | "kimi" | "mistral" | "openrouter";
export type ModeModelSelection = {
  model: ModelId;
  thinking: ThinkingLevel;
  use1mContext: boolean;
};
export type ModeModelSelections = Record<AgentMode, ModeModelSelection>;

const BUILTIN_1M_CONTEXT_BETA = ["anthropic:claude-opus-5-5"];
let models1mContextBeta = new Set<ModelId>(BUILTIN_1M_CONTEXT_BETA);

export function modelSupports1mContextBeta(model: ModelId): boolean {
  return models1mContextBeta.has(model);
}

export function use1mContextFromRef(
  model: ModelRef | null | undefined,
): boolean {
  return model?.use1mContext === true;
}

export function modelRefWithUse1mContext(
  model: ModelRef,
  enabled: boolean,
): ModelRef {
  if (!enabled) {
    const { use1mContext: _drop, ...rest } = model;
    return rest;
  }
  return { ...model, use1mContext: true };
}

export type ModelEntry = {
  value: ModelId;
  provider: ProviderId;
  label: string;
  thinking: readonly ThinkingLevel[];
  defaultThinking: ThinkingLevel;
  supportsFast?: boolean;
};

export const PROVIDERS: {
  value: ProviderId;
  label: string;
  icon: string;
}[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    icon: "simple-icons:anthropic",
  },
  {
    value: "openai",
    label: "OpenAI",
    icon: "simple-icons:openai",
  },
  {
    value: "google",
    label: "Google",
    icon: "simple-icons:google",
  },
  {
    value: "xai",
    label: "xAI Composer",
    icon: "simple-icons:x",
  },
  {
    value: "kimi",
    label: "Kimi",
    icon: "local:kimi",
  },
  {
    value: "mistral",
    label: "Mistral",
    icon: "simple-icons:mistralai",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    icon: "simple-icons:openrouter",
  },
];

export const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

export const MODELS: ModelEntry[] = [
  {
    value: "anthropic:claude-opus-5-5",
    provider: "anthropic",
    label: "Opus 5.5",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-fable-5-1",
    provider: "anthropic",
    label: "Fable 5.1",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-opus-5",
    provider: "anthropic",
    label: "Opus 5",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-sonnet-5-5",
    provider: "anthropic",
    label: "Sonnet 5.5",
    thinking: ["off", "low", "medium", "high", "max"],
    defaultThinking: "high",
  },
  {
    value: "anthropic:claude-sonnet-5",
    provider: "anthropic",
    label: "Sonnet 5",
    thinking: ["off", "low", "medium", "high", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-fable-5",
    provider: "anthropic",
    label: "Fable 5",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-opus-4-8",
    provider: "anthropic",
    label: "Opus 4.8",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-haiku-5-5",
    provider: "anthropic",
    label: "Haiku 5.5",
    thinking: ["off", "low", "medium", "high", "max"],
    defaultThinking: "high",
  },
  {
    value: "anthropic:claude-haiku-4-5",
    provider: "anthropic",
    label: "Haiku 4.5",
    thinking: ["off", "low", "medium", "high"],
    defaultThinking: "medium",
  },
  {
    value: "openai:gpt-6-luna",
    provider: "openai",
    label: "GPT-6 Luna",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-6.1-sol",
    provider: "openai",
    label: "GPT-6.1 Sol",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-6.1-terra",
    provider: "openai",
    label: "GPT-6.1 Terra",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-6-sol",
    provider: "openai",
    label: "GPT-6 Sol",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-6-astra",
    provider: "openai",
    label: "GPT-6 Astra",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-5.6-sol",
    provider: "openai",
    label: "GPT-5.6 Sol",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    thinking: ["off", "low", "medium", "high", "xhigh"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-5.3-codex",
    provider: "openai",
    label: "GPT-5.3 Codex",
    thinking: ["off", "low", "medium", "high", "xhigh"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-5.3-codex-spark",
    provider: "openai",
    label: "GPT-5.3 Codex Spark",
    thinking: ["low", "medium", "high", "xhigh"],
    defaultThinking: "low",
    supportsFast: true,
  },
  {
    value: "openai:gpt-5.2",
    provider: "openai",
    label: "GPT-5.2",
    thinking: ["off", "low", "medium", "high", "xhigh"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "google:gemini-3.1-pro",
    provider: "google",
    label: "Gemini 3.1 Pro",
    thinking: ["low", "medium", "high"],
    defaultThinking: "high",
  },
  {
    value: "google:gemini-3-flash",
    provider: "google",
    label: "Gemini 3 Flash",
    thinking: ["minimal", "low", "medium", "high"],
    defaultThinking: "high",
  },
  {
    value: "google:gemini-3.5-flash",
    provider: "google",
    label: "Gemini 3.5 Flash",
    thinking: ["minimal", "low", "medium", "high"],
    defaultThinking: "high",
  },
  {
    value: "xai:composer-2.5",
    provider: "xai",
    label: "Composer 2.5",
    thinking: ["off"],
    defaultThinking: "off",
  },
  {
    value: "kimi:kimi-3.1-pro",
    provider: "kimi",
    label: "Kimi 3.1 Pro",
    thinking: ["off", "high"],
    defaultThinking: "high",
  },
  {
    value: "kimi:kimi-k2.7-code",
    provider: "kimi",
    label: "Kimi K2.7 Code",
    thinking: ["high"],
    defaultThinking: "high",
  },
  {
    value: "kimi:kimi-for-coding",
    provider: "kimi",
    label: "Kimi K2.6",
    thinking: ["off", "high"],
    defaultThinking: "high",
  },
  {
    value: "mistral:mistral-large-latest",
    provider: "mistral",
    label: "Mistral Large",
    thinking: ["off"],
    defaultThinking: "off",
  },
  {
    value: "mistral:codestral-latest",
    provider: "mistral",
    label: "Codestral",
    thinking: ["off"],
    defaultThinking: "off",
  },
];

/** Shape of one model in the remote `models.json` (see crates/claakecode-core/src/catalog.rs). */
export type CatalogModel = {
  provider: ProviderId;
  id: string;
  label: string;
  thinking: string[];
  defaultThinking: string;
  supportsFast?: boolean;
  contextWindow1m?: number | null;
  hidden?: boolean;
};

const BUILTIN_MODELS: readonly ModelEntry[] = [...MODELS];

// MODELS is mutated in place; this version lets React memos depend on it.
let catalogVersion = 0;
const catalogListeners = new Set<() => void>();

export function subscribeModelCatalog(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

/** Re-renders the caller and changes identity whenever the model catalog changes. */
export function useModelCatalogVersion(): number {
  return useSyncExternalStore(subscribeModelCatalog, () => catalogVersion);
}

/**
 * Replacement for a selection that is no longer available (e.g. hidden by the catalog):
 * first available model of the same provider, else the first available model.
 */
export function fallbackModelEntry(
  available: readonly ModelEntry[],
  modelValue: ModelId,
): ModelEntry | undefined {
  const provider = modelRefFromId(modelValue).provider;
  return (
    available.find((m) => m.value === modelValue) ??
    available.find((m) => m.provider === provider) ??
    available[0]
  );
}

/** Providers whose models come from the catalog; others (mistral) keep their own source. */
const CATALOG_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "xai",
  "kimi",
]);

/**
 * Load the catalog sent by the backend, which is already merged in Rust (remote wins,
 * hidden flagged, file order). Hidden entries are dropped here, nothing is re-merged.
 * Empty/invalid catalog => TypeScript built-ins (only before the first IPC answer or if it fails).
 */
export function applyModelCatalog(catalog: readonly CatalogModel[] | null | undefined): void {
  const levels = new Set(THINKING_LEVELS.map((l) => l.value as string));
  const remote = (catalog ?? []).filter(
    (m) => m.thinking.length > 0 && m.thinking.every((t) => levels.has(t)),
  );
  const fromCatalog: ModelEntry[] = remote
    .filter((m) => !m.hidden)
    .map((m) => ({
      value: modelId(m.provider, m.id),
      provider: m.provider,
      label: m.label,
      thinking: m.thinking as ThinkingLevel[],
      defaultThinking: m.defaultThinking as ThinkingLevel,
      supportsFast: m.supportsFast || undefined,
    }));
  MODELS.splice(
    0,
    MODELS.length,
    ...(remote.length
      ? [...fromCatalog, ...BUILTIN_MODELS.filter((m) => !CATALOG_PROVIDERS.has(m.provider))]
      : BUILTIN_MODELS),
  );
  models1mContextBeta = new Set(
    remote.length
      ? remote.filter((m) => m.contextWindow1m).map((m) => modelId(m.provider, m.id))
      : BUILTIN_1M_CONTEXT_BETA,
  );
  catalogVersion += 1;
  for (const listener of catalogListeners) listener();
}

/**
 * Keep MODELS in sync with the backend without blocking startup: subscribe to updates FIRST,
 * then read the local state, and drop that read if an update already arrived (it is newer).
 * Never throws: on any failure the built-in list stays.
 */
export async function startModelCatalogSync(
  readLocal: () => Promise<{ models: CatalogModel[] }>,
  subscribe: (onUpdate: (models: CatalogModel[]) => void) => Promise<unknown>,
): Promise<void> {
  let updated = false;
  try {
    await subscribe((models) => {
      updated = true;
      applyModelCatalog(models);
    });
  } catch {
    // No live updates: the local read below still gives the cached catalog.
  }
  try {
    const local = await readLocal();
    if (!updated) applyModelCatalog(local.models);
  } catch {
    // Built-in list stays.
  }
}

// Fallback Mistral models when no catalog is loaded
const MISTRAL_FALLBACK_MODELS: ModelEntry[] = [
  {
    value: "mistral:mistral-large-latest",
    provider: "mistral",
    label: "Mistral Large",
    thinking: ["off"],
    defaultThinking: "off",
  },
  {
    value: "mistral:codestral-latest",
    provider: "mistral",
    label: "Codestral",
    thinking: ["off"],
    defaultThinking: "off",
  },
];

const OPENROUTER_THINKING: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];
const OPENROUTER_NO_THINKING: readonly ThinkingLevel[] = ["off"];

export function sanitizeOpenRouterName(name: string | null | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw) return "";
  // OpenRouter prefixes most names with the underlying provider, e.g. "OpenAI: GPT-4o".
  // The provider icon already conveys that information in Claake Code, so drop the prefix.
  const colon = raw.indexOf(":");
  if (colon <= 0) return raw;
  const tail = raw.slice(colon + 1).trim();
  return tail || raw;
}

export function modelsWithOpenRouter(
  openRouterModels: readonly OpenRouterModel[] = [],
): ModelEntry[] {
  return [...MODELS, ...openRouterModelEntries(openRouterModels)];
}

export function modelsWithMistralAndOpenRouter(
  mistralModels: readonly MistralModel[] = [],
  openRouterModels: readonly OpenRouterModel[] = [],
): ModelEntry[] {
  const mistralEntries =
    mistralModels.length > 0 ? mistralModelEntries(mistralModels) : MISTRAL_FALLBACK_MODELS;
  // Replace MODELS' mistral entries with dynamic ones
  const base = MODELS.filter((m) => m.provider !== "mistral");
  return [...base, ...mistralEntries, ...openRouterModelEntries(openRouterModels)];
}

export function availableModelsForProviders(
  configuredProviders: readonly string[],
  openRouterModels: readonly OpenRouterModel[] = [],
  mistralModels: readonly MistralModel[] = [],
): ModelEntry[] {
  const configured = new Set(configuredProviders);
  const mistralEntries =
    mistralModels.length > 0
      ? mistralModelEntries(mistralModels)
      : MODELS.filter((m) => m.provider === "mistral");
  return [
    ...MODELS.filter(
      (model) => configured.has(model.provider) && model.provider !== "mistral",
    ),
    ...(configured.has("mistral") ? mistralEntries : []),
    ...(configured.has("openrouter") ? openRouterModelEntries(openRouterModels) : []),
  ];
}

function openRouterModelEntries(
  openRouterModels: readonly OpenRouterModel[],
): ModelEntry[] {
  return openRouterModels.map((model) => ({
    value: modelId("openrouter", model.id),
    provider: "openrouter",
    label: sanitizeOpenRouterName(model.name) || model.id,
    thinking: model.supportsThinking ? OPENROUTER_THINKING : OPENROUTER_NO_THINKING,
    defaultThinking: model.supportsThinking ? "medium" : "off",
  }));
}

function mistralModelEntries(mistralModels: readonly MistralModel[]): ModelEntry[] {
  return mistralModels
    .filter((m) => !m.deprecated)
    .map((model) => ({
      value: modelId("mistral", model.id),
      provider: "mistral",
      label: model.name || model.id,
      thinking: ["off"] as ThinkingLevel[],
      defaultThinking: "off" as ThinkingLevel,
    }));
}

export function modelIdFromRef(model: ModelRef | null | undefined): ModelId {
  if (model?.provider && model.name) {
    return modelId(model.provider, normalizedModelName(model.provider, model.name));
  }
  return MODELS[0].value;
}

export function modelRefFromId(model: ModelId): ModelRef {
  const separator = model.indexOf(":");
  if (separator < 0) return { provider: "anthropic", name: model };
  const provider = model.slice(0, separator);
  const name = model.slice(separator + 1);
  return { provider, name };
}

export function thinkingFromRef(
  model: ModelRef | null | undefined,
): ThinkingLevel {
  if (model?.provider === "google") {
    if (model.name.endsWith("-low")) return "low";
    if (model.name.endsWith("-medium")) return "medium";
    if (model.name.endsWith("-high")) return "high";
    if (model.effort === "low" || model.effort === "medium" || model.effort === "high") {
      return model.effort;
    }
    if (model.effort === "none") {
      // Pro variants don't support `minimal`; clamp to low so we never send
      // an invalid thinking level for those models.
      return model.name.includes("-pro") ? "low" : "minimal";
    }
    return "high";
  }
  if (model?.provider === "kimi") {
    if (kimiThinkingOnly(model.name)) return "high";
    if (model.effort === "none") return "off";
    return "high";
  }
  if (model?.provider === "mistral" || (model?.provider === "xai" && !xaiHasThinking(model.name))) {
    return "off";
  }
  if (model?.provider === "openrouter") {
    if (model.effort === "none") return "off";
    if (
      model.effort === "low" ||
      model.effort === "medium" ||
      model.effort === "high" ||
      model.effort === "xhigh"
    ) {
      return model.effort;
    }
    if (model.effort === "max") {
      return "xhigh";
    }
    return "medium";
  }
  if (
    model?.provider === "openai" &&
    model.name === "gpt-5.3-codex-spark" &&
    model.effort === "none"
  ) {
    return "low";
  }
  if (model?.effort === "none") return "off";
  if (model?.effort === "xhigh") return "xhigh";
  if (
    model?.provider === "openai" &&
    model.effort === "max" &&
    !supportsOpenAiMaxEffort(model.name)
  ) {
    return "xhigh";
  }
  if (
    model?.effort === "low" ||
    model?.effort === "medium" ||
    model?.effort === "high" ||
    model?.effort === "max"
  ) {
    return model.effort;
  }
  return "medium";
}

export function modelRefWithThinking(
  model: ModelRef,
  thinking: ThinkingLevel,
): ModelRef {
  if (model.provider === "google") {
    const name = normalizedGoogleModelName(model.name);
    if (thinking === "off") return { ...model, name, effort: "low" };
    if (thinking === "minimal") {
      // Pro variants reject `minimal` server-side; clamp to low.
      return name.includes("-pro")
        ? { ...model, name, effort: "low" }
        : { ...model, name, effort: "none" };
    }
    if (thinking === "xhigh" || thinking === "max") return { ...model, name, effort: "high" };
    return { ...model, name, effort: thinking };
  }
  if (model.provider === "kimi" && kimiThinkingOnly(model.name)) {
    return { ...model, effort: "high" };
  }
  if (
    model.provider === "openai" &&
    model.name === "gpt-5.3-codex-spark" &&
    thinking === "off"
  ) {
    return { ...model, effort: "low" };
  }
  if (thinking === "off") return { ...model, effort: "none" };
  if (model.provider === "kimi") return { ...model, effort: "high" };
  if (model.provider === "mistral" || (model.provider === "xai" && !xaiHasThinking(model.name))) {
    return { ...model, effort: "none" };
  }
  if (model.provider === "openrouter" && thinking === "max") {
    return { ...model, effort: "xhigh" };
  }
  if (model.provider === "openrouter" && thinking === "xhigh") {
    return { ...model, effort: "high" };
  }
  // `minimal` is Gemini-only on the backend. The Google branch above already
  // handled it; for any other provider that ever surfaces it, clamp to low.
  if (thinking === "minimal") return { ...model, effort: "low" };
  return { ...model, effort: thinking };
}

export function selectionFromRef(
  model: ModelRef | null | undefined,
): ModeModelSelection {
  return {
    model: modelIdFromRef(model),
    thinking: thinkingFromRef(model),
    use1mContext: use1mContextFromRef(model),
  };
}

function modelId(provider: string, name: string): ModelId {
  return `${provider}:${name}`;
}

function catalogEntry(provider: string, name: string): ModelEntry | undefined {
  return MODELS.find((entry) => entry.value === modelId(provider, name));
}

/** Catalog says "no off level" => thinking is always on (same rule as the Rust side). */
function kimiThinkingOnly(name: string): boolean {
  const entry = catalogEntry("kimi", name);
  return entry ? !entry.thinking.includes("off") : name === "kimi-k2.7-code";
}

/** xAI models listed with more than "off" in the catalog really take a thinking level. */
function xaiHasThinking(name: string): boolean {
  return (catalogEntry("xai", name)?.thinking ?? []).some((level) => level !== "off");
}

function supportsOpenAiMaxEffort(modelName: string): boolean {
  const entry = catalogEntry("openai", modelName);
  if (entry) return entry.thinking.includes("max");
  return (
    modelName === "gpt-6" ||
    modelName.startsWith("gpt-6-") ||
    modelName.startsWith("gpt-6.") ||
    modelName === "gpt-5.6" ||
    modelName.startsWith("gpt-5.6-")
  );
}

function normalizedModelName(provider: string, name: string): string {
  if (provider === "google") return normalizedGoogleModelName(name);
  return name;
}

function normalizedGoogleModelName(name: string): string {
  if (name === "gemini-3.1-pro-preview") return "gemini-3.1-pro";
  if (name === "gemini-3-flash-preview") return "gemini-3-flash";
  if (name === "gemini-3.1-pro-low" || name === "gemini-3.1-pro-high") {
    return "gemini-3.1-pro";
  }
  if (
    name === "gemini-3.5-flash-low" ||
    name === "gemini-3.5-flash-medium" ||
    name === "gemini-3.5-flash-high"
  ) {
    return "gemini-3.5-flash";
  }
  return name;
}

export function selectionsFromSettings(
  settings: ModeModelSettings | null | undefined,
  fallback: ModelRef,
): ModeModelSelections {
  return {
    act: selectionFromRef(settings?.act ?? fallback),
    ask: selectionFromRef(settings?.ask ?? settings?.act ?? fallback),
    plan: selectionFromRef(settings?.plan ?? fallback),
    goal: selectionFromRef(settings?.goal ?? settings?.act ?? fallback),
  };
}
