/**
 * Embedding provider catalog, defaults, and helper functions.
 *
 * Architecture:
 *  - EMBEDDING_PROVIDERS   → static catalog (icons, models, descriptions)
 *  - EmbeddingSettings     → persisted runtime state (enabled, selectedModel, …)
 *  - Helper functions      → derive display state from the above
 */

import type {
  EmbeddingConnectionStatus,
  EmbeddingModel,
  EmbeddingProviderDefinition,
  EmbeddingProviderId,
  EmbeddingProviderStatus,
  EmbeddingSettings,
} from "../types";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EMBEDDING_SETTINGS_CHANGED_EVENT =
  "claakecode:embedding-settings-changed";

// ---------------------------------------------------------------------------
// Static catalog
// ---------------------------------------------------------------------------

export const EMBEDDING_PROVIDERS: EmbeddingProviderDefinition[] = [
  {
    id: "openai",
    name: "OpenAI",
    icon: "simple-icons:openai",
    description:
      "General-purpose and code embeddings. Reuses your existing OpenAI credentials — no extra key needed.",
    credentialsSource: "openai",
    models: [
      {
        id: "text-embedding-3-small",
        label: "text-embedding-3-small",
        dimensions: 1536,
        description: "Fast & cost-efficient",
      },
      {
        id: "text-embedding-3-large",
        label: "text-embedding-3-large",
        dimensions: 3072,
        description: "Highest quality",
      },
    ],
  },
  {
    id: "voyage",
    name: "Voyage AI",
    icon: "solar:routing-linear",
    description:
      "State-of-the-art embeddings for code and general text. Requires a standalone Voyage API key.",
    tokenEnvHint: "VOYAGE_API_KEY",
    models: [
      {
        id: "voyage-3",
        label: "voyage-3",
        dimensions: 1024,
        description: "General purpose",
      },
      {
        id: "voyage-code-3",
        label: "voyage-code-3",
        dimensions: 1024,
        description: "Code-optimised",
      },
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    icon: "simple-icons:cohere",
    description:
      "English and multilingual embeddings. Supports 100+ languages out of the box.",
    tokenEnvHint: "COHERE_API_KEY",
    models: [
      {
        id: "embed-english-v3.0",
        label: "embed-english-v3.0",
        dimensions: 1024,
        description: "English — high accuracy",
      },
      {
        id: "embed-multilingual-v3.0",
        label: "embed-multilingual-v3.0",
        dimensions: 1024,
        description: "100+ languages",
      },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    icon: "simple-icons:mistralai",
    description:
      "European embeddings. Reuses your existing Mistral API key or OAuth session.",
    credentialsSource: "mistral",
    models: [
      {
        id: "mistral-embed",
        label: "mistral-embed",
        dimensions: 1024,
        description: "General purpose",
      },
    ],
  },
  {
    id: "google",
    name: "Google",
    icon: "simple-icons:google",
    description:
      "Gemini-family embeddings. Reuses your existing Google credentials.",
    credentialsSource: "google",
    models: [
      {
        id: "text-embedding-004",
        label: "text-embedding-004",
        dimensions: 768,
        description: "Stable & efficient",
      },
      {
        id: "gemini-embedding-exp-03-07",
        label: "gemini-embedding-exp",
        dimensions: 3072,
        description: "Experimental — highest quality",
      },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    icon: "solar:server-square-linear",
    description:
      "Run embeddings fully offline. Reuses your local Ollama endpoint — no data leaves your machine.",
    credentialsSource: "ollama",
    isLocal: true,
    models: [
      {
        id: "nomic-embed-text",
        label: "nomic-embed-text",
        dimensions: 768,
        description: "Fast local model",
      },
      {
        id: "mxbai-embed-large",
        label: "mxbai-embed-large",
        dimensions: 1024,
        description: "Higher quality local model",
      },
    ],
  },
  {
    id: "custom",
    name: "Custom HTTP",
    icon: "solar:link-round-linear",
    description:
      "Point to any OpenAI-compatible or raw-vector HTTP endpoint. Useful for self-hosted models or private deployments.",
    tokenEnvHint: "CUSTOM_EMBED_API_KEY",
    isLocal: false,
    models: [
      {
        id: "custom",
        label: "Custom model",
        dimensions: 0,
        description: "Dimensions inferred at first call",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const EMPTY_EMBEDDING_SETTINGS: EmbeddingSettings = {
  providers: [],
  localOnlyMode: false,
};

// ---------------------------------------------------------------------------
// Normalise / hydrate
// ---------------------------------------------------------------------------

/** Ensure every known provider has a status entry, fill gaps with sensible defaults. */
export function normalizeEmbeddingSettings(
  raw: Partial<EmbeddingSettings>,
): EmbeddingSettings {
  const rawProviders: EmbeddingProviderStatus[] = raw.providers ?? [];

  const providers = EMBEDDING_PROVIDERS.map((def, idx): EmbeddingProviderStatus => {
    const existing = rawProviders.find((p) => p.providerId === def.id);
    return {
      providerId: def.id,
      enabled: existing?.enabled ?? false,
      selectedModel: existing?.selectedModel ?? def.models[0]?.id ?? null,
      connectionStatus: existing?.connectionStatus ?? "disconnected",
      error: existing?.error ?? null,
      tokenConfigured: existing?.tokenConfigured ?? false,
      tokenPreview: existing?.tokenPreview ?? null,
      priorityOrder: existing?.priorityOrder ?? idx,
      budgetCap: existing?.budgetCap ?? null,
    };
  });

  return {
    providers,
    localOnlyMode: raw.localOnlyMode ?? false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function embeddingStatusForProvider(
  settings: EmbeddingSettings,
  providerId: string,
): EmbeddingProviderStatus {
  const provider = EMBEDDING_PROVIDERS.find((p) => p.id === providerId);
  return (
    settings.providers.find((p) => p.providerId === providerId) ?? {
      providerId,
      enabled: false,
      selectedModel: provider?.models[0]?.id ?? null,
      connectionStatus: "disconnected",
      priorityOrder: 99,
    }
  );
}

export function embeddingEnabledCount(settings: EmbeddingSettings): number {
  return settings.providers.filter((p) => p.enabled).length;
}

export function embeddingConnectedProviders(
  settings: EmbeddingSettings,
): EmbeddingProviderStatus[] {
  return settings.providers.filter((p) => p.enabled);
}

/** Sorted by priorityOrder for display in the priority list. */
export function embeddingProvidersSortedByPriority(
  settings: EmbeddingSettings,
): EmbeddingProviderStatus[] {
  return [...settings.providers].sort((a, b) => a.priorityOrder - b.priorityOrder);
}

export function embeddingStatusTone(
  status: EmbeddingConnectionStatus,
): "ok" | "error" | "pending" | "off" {
  switch (status) {
    case "connected":
      return "ok";
    case "connecting":
      return "pending";
    case "error":
      return "error";
    default:
      return "off";
  }
}

export function embeddingStatusLabel(
  status: EmbeddingConnectionStatus,
  enabled: boolean,
): string {
  if (!enabled) return "Disabled";
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "error":
      return "Needs attention";
    default:
      return "Not connected";
  }
}

export function embeddingDotTone(
  status: EmbeddingProviderStatus,
): "ok" | "error" | "pending" | "off" {
  if (!status.enabled) return "off";
  return embeddingStatusTone(status.connectionStatus);
}

export function embeddingModelLabel(
  provider: EmbeddingProviderDefinition,
  modelId: string | null,
): string {
  if (!modelId) return provider.models[0]?.label ?? "—";
  return provider.models.find((m) => m.id === modelId)?.label ?? modelId;
}

export function embeddingModelDimensions(
  provider: EmbeddingProviderDefinition,
  modelId: string | null,
): number | null {
  if (!modelId) return provider.models[0]?.dimensions ?? null;
  return provider.models.find((m) => m.id === modelId)?.dimensions ?? null;
}

export function embeddingSettingsFingerprint(
  settings: EmbeddingSettings,
): string {
  return JSON.stringify(settings);
}
