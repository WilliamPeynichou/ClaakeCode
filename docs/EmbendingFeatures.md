# Embedding Providers — Feature Documentation (`sinew-release-claake-1.21`)

## Overview

`sinew-release-claake-1.21` ships the **Settings → Embedding** section: a dedicated panel for configuring embedding providers that power semantic search across the Claake agent and user-built projects.

The section mirrors the look and feel of the existing **Skills** section — two-column layout with a scrollable provider list on the left and a rich detail panel on the right.

---

## Files added / modified

| File | Change |
|---|---|
| `src/types.ts` | +`EmbeddingProviderId`, `EmbeddingModel`, `EmbeddingProviderDefinition`, `EmbeddingConnectionStatus`, `EmbeddingProviderStatus`, `EmbeddingSettings` |
| `src/lib/embeddingSettings.ts` | New — static catalog, defaults, `normalizeEmbeddingSettings`, display helpers |
| `src/components/EmbeddingSettingsSection.tsx` | New — `EmbeddingSection`, `EmbeddingProviderDetail`, `EmbeddingModelCard` |
| `src/components/SettingsPane.tsx` | Wired: nav item, state, all callbacks, section renderer |
| `src/styles.css` | +`settings-pane__body--embedding` and all `settings-pane__embedding-*` classes |

---

## Supported providers (v1 catalog)

| ID | Name | Models | Credentials |
|---|---|---|---|
| `openai` | OpenAI | `text-embedding-3-small` (1536d), `text-embedding-3-large` (3072d) | Reuses existing OpenAI OAuth |
| `voyage` | Voyage AI | `voyage-3` (1024d), `voyage-code-3` (1024d) | Standalone `VOYAGE_API_KEY` |
| `cohere` | Cohere | `embed-english-v3.0` (1024d), `embed-multilingual-v3.0` (1024d) | Standalone `COHERE_API_KEY` |
| `mistral` | Mistral | `mistral-embed` (1024d) | Reuses existing Mistral API key / OAuth |
| `google` | Google | `text-embedding-004` (768d), `gemini-embedding-exp` (3072d) | Reuses existing Google OAuth |
| `ollama` | Ollama (local) | `nomic-embed-text` (768d), `mxbai-embed-large` (1024d) | Local endpoint, no key needed |
| `custom` | Custom HTTP | Custom model (dimensions inferred) | Optional `CUSTOM_EMBED_API_KEY` |

---

## UI — Settings → Embedding

### Header
- **Title** — "Embedding"
- **Subtitle** — dynamic: "Enable at least one provider…" / "N providers active — the agent picks the best one per query."
- **Local-only toggle button** — suspends all non-local providers for offline / privacy-sensitive work. Highlighted when active.
- **Save button** — persists `EmbeddingSettings` to disk. Enabled only when `dirty`.

### Left panel — provider list
- One row per provider, in catalog order.
- Each row shows: **status dot** (ok / pending / error / off), **provider icon**, **provider name**, optional **priority badge** (`#1`, `#2`…) for enabled providers, optional **"local" badge**, **enable toggle** (mini switch).
- Disabled rows are shown at reduced opacity.
- Selecting a row opens the detail panel on the right.
- When at least one provider is enabled, a collapsed **Active embeddings** summary chip list appears at the top of the list.

### Right panel — provider detail

Organised into collapsible `settings-pane__database-block` groups:

| Block | Contents |
|---|---|
| **Status** | Enable/disable toggle with label; priority arrows (↑ ↓) when enabled |
| **API Key** | Password input + save / clear buttons (hidden for `reuse-credential` providers) |
| **Credentials** | Info banner for reuse-credential providers (OpenAI / Mistral / Google / Ollama) |
| **Model** | Card-grid of available models; selected card is highlighted; each card shows model name, dimensions (e.g. `1024d`), and a short description |
| **Monthly budget cap** | Dollar-amount input + Set cap / Remove cap; `$N/month` summary line |
| **Index** | Re-index button (asks for confirmation before running); info note about on-demand lazy indexing |

---

## Activation model

- Multiple providers can be **enabled simultaneously** — no radio, no single primary.
- The agent picks the best active provider per query (code-oriented → `voyage-code-3`; multilingual → Cohere multilingual; offline → Ollama).
- **Priority order** is user-editable via the ↑ ↓ arrows in the detail panel; it is used as a tie-break heuristic.
- **Local-only mode** (header toggle) disables all non-local providers in one click. Toggling it back off restores the previous state (providers re-enabled individually as needed).

---

## State management (`SettingsPane.tsx`)

| State slice | Type | Purpose |
|---|---|---|
| `embeddingSettings` | `EmbeddingSettings` | Live in-memory settings, mutated by callbacks |
| `savedEmbeddingJson` | `string` | Fingerprint of the last-saved state; drives `dirty` flag |
| `embeddingLoading` | `boolean` | Reserved for future API fetch |
| `embeddingSaving` | `boolean` | True while `saveEmbeddingSettings()` is running |
| `embeddingStatus` | `string \| null` | Status banner text (Saved, Cleared, Re-indexed…) |
| `embeddingBusyProviderId` | `string \| null` | Disables controls for the provider currently being mutated |

Callbacks exposed to `EmbeddingSection`:

| Callback | Action |
|---|---|
| `toggleEmbeddingEnabled(id)` | Flips `enabled` on the matching provider |
| `selectEmbeddingModel(id, modelId)` | Updates `selectedModel` |
| `saveEmbeddingApiKey(id, key)` | Stores key → sets `tokenConfigured + tokenPreview + connectionStatus: "connected"` |
| `clearEmbeddingApiKey(id)` | Removes key → resets connection state, auto-disables provider |
| `setEmbeddingBudgetCap(id, cap)` | Updates `budgetCap` (null = no cap) |
| `reindexEmbeddingProvider(id)` | Triggers re-index; stub until backend command is wired |
| `toggleEmbeddingLocalOnly()` | Flips `localOnlyMode`; auto-disables non-local providers on switch-on |
| `moveEmbeddingPriority(id, "up"\|"down")` | Swaps `priorityOrder` values between adjacent enabled providers |
| `saveEmbeddingSettings()` | Persists to disk (stub → `setSavedEmbeddingJson`) |

---

## Vector storage design (planned backend, v1)

- **SQLite + `sqlite-vec` extension** inside the existing Claake app store.
- One logical vector table per `(provider, model, dimension)` tuple — vectors of different dimensions cannot share an index.
- Metadata columns: `source_kind`, `source_id`, `chunk_pos`, `provider_id`, `model_id`, `content_hash`, `created_at`.
- Re-embedding triggers: content hash change or provider default model change.
- Indexing is **on-demand / lazy** — runs when the agent calls `semantic_search` and finds no fresh vectors. A manual "Re-index now" button warms the cache proactively.

---

## Agent integration (`semantic_search` tool — planned)

```
semantic_search(
  query:         string,          // natural-language query
  source_filter: SourceKind[],    // "workspace" | "conversations" | "skills" | "attachments" | "history"
  top_k?:        number,          // default 5
) → Chunk[]
```

1. Picks the best enabled provider for the query via heuristic + priority list.
2. Lazy-indexes the source if no fresh vectors exist.
3. Embeds the query with the chosen provider.
4. Runs vector search in sqlite-vec.
5. Returns ranked chunks with `source_kind`, `source_id`, `chunk_pos`, `score`.

The same tool is exposed to **user projects coded in Claake** via Claake's internal API, so apps developed inside the IDE can call `semantic_search` and `embed_text` without managing credentials.

---

## Open questions (carried from plan, to resolve before backend wiring)

1. **Parallel indexes** — confirmed approach: one index per `(provider, model, dimension)` tuple. Disk usage scales linearly with enabled providers. Acceptable for v1.
2. **Custom HTTP — single or multiple endpoints?** — v1 ships a single "Custom HTTP" card. Multi-endpoint support is a future enhancement.
3. **User-project API gate** — decision pending: add an explicit "Allow projects to use embeddings" toggle in Settings → Embedding for security, or trust Claake's existing sandboxing.

---

## Out of scope (v1)

- Cross-provider re-ranking (Cohere Rerank, etc.)
- Cloud-hosted vector databases (Pinecone, Qdrant Cloud, Weaviate)
- Per-workspace overrides of enabled providers
- Background / continuous indexing
- Embedding usage analytics / cost tracking dashboard
