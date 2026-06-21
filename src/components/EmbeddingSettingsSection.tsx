/**
 * EmbeddingSettingsSection
 *
 * Settings → Embedding  — UI component
 *
 * Layout: two-column grid (mirroring the Skills section).
 *   Left  → scrollable list of embedding provider items
 *           (status dot · icon · name · enable toggle)
 *   Right → detail panel for the selected provider:
 *           connection / API key, model selector, budget cap, re-index
 */

import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import type {
  EmbeddingModel,
  EmbeddingProviderDefinition,
  EmbeddingProviderStatus,
  EmbeddingSettings,
} from "../types";
import {
  EMBEDDING_PROVIDERS,
  embeddingDotTone,
  embeddingModelLabel,
  embeddingStatusLabel,
  embeddingStatusTone,
} from "../lib/embeddingSettings";

// ---------------------------------------------------------------------------
// Public prop types
// ---------------------------------------------------------------------------

export type EmbeddingSectionProps = {
  settings: EmbeddingSettings;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  status: string | null;
  busyProviderId: string | null;
  /** True if the OpenAI provider is already connected elsewhere in Settings → Providers. */
  openAiConnected: boolean;
  /** True if the Mistral provider is already connected elsewhere. */
  mistralConnected: boolean;
  /** True if the Google provider is already connected elsewhere. */
  googleConnected: boolean;
  onSave: () => void;
  onToggleEnabled: (providerId: string) => void;
  onSelectModel: (providerId: string, modelId: string) => void;
  onSaveApiKey: (providerId: string, apiKey: string) => void;
  onClearApiKey: (providerId: string) => void;
  onSetBudgetCap: (providerId: string, cap: number | null) => void;
  onReindex: (providerId: string) => void;
  onToggleLocalOnly: () => void;
  onMovePriority: (providerId: string, direction: "up" | "down") => void;
};

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function EmbeddingSection({
  settings,
  loading,
  saving,
  dirty,
  status,
  busyProviderId,
  openAiConnected,
  mistralConnected,
  googleConnected,
  onSave,
  onToggleEnabled,
  onSelectModel,
  onSaveApiKey,
  onClearApiKey,
  onSetBudgetCap,
  onReindex,
  onToggleLocalOnly,
  onMovePriority,
}: EmbeddingSectionProps) {
  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    EMBEDDING_PROVIDERS[0]?.id ?? "",
  );

  const enabledCount = settings.providers.filter((p) => p.enabled).length;

  const selectedDef =
    EMBEDDING_PROVIDERS.find((p) => p.id === selectedProviderId) ??
    EMBEDDING_PROVIDERS[0] ??
    null;

  const selectedStatus = selectedDef
    ? (settings.providers.find((p) => p.providerId === selectedDef.id) ?? null)
    : null;

  return (
    <>
      {/* ── Header ── */}
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">Embedding</h1>
          <p className="settings-pane__subtitle">
            {loading
              ? "Loading providers…"
              : enabledCount === 0
                ? "Enable at least one provider to activate semantic search."
                : `${enabledCount} provider${enabledCount === 1 ? "" : "s"} active — the agent picks the best one per query.`}
          </p>
        </div>
        <div className="settings-pane__actions">
          {status && (
            <span
              className="settings-pane__status"
              data-tone={status === "Saved" ? "ok" : "pending"}
            >
              {status}
            </span>
          )}
          {/* Local-only toggle */}
          <button
            type="button"
            className="settings-pane__btn"
            data-primary={settings.localOnlyMode ? "true" : undefined}
            onClick={onToggleLocalOnly}
            title={
              settings.localOnlyMode
                ? "Local-only mode ON — only Ollama and local endpoints are active"
                : "Enable local-only mode"
            }
          >
            <Icon icon="solar:home-wifi-linear" width={13} height={13} />
            <span>{settings.localOnlyMode ? "Local only: ON" : "Local only"}</span>
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            data-primary="true"
            onClick={onSave}
            disabled={loading || saving || !dirty}
          >
            <Icon
              icon={saving ? "solar:refresh-linear" : "solar:diskette-linear"}
              width={13}
              height={13}
            />
            <span>{saving ? "Saving…" : "Save"}</span>
          </button>
        </div>
      </header>

      {/* ── Two-column body ── */}
      <div className="settings-pane__body settings-pane__body--embedding">
        {/* Left — provider list */}
        <aside className="settings-pane__embedding-list">
          {/* Active summary */}
          {enabledCount > 0 && (
            <div className="settings-pane__embedding-summary">
              <span className="settings-pane__embedding-summary-label">
                Active embeddings
              </span>
              {settings.providers
                .filter((p) => p.enabled)
                .sort((a, b) => a.priorityOrder - b.priorityOrder)
                .map((p) => {
                  const def = EMBEDDING_PROVIDERS.find((d) => d.id === p.providerId);
                  if (!def) return null;
                  return (
                    <span
                      key={p.providerId}
                      className="settings-pane__chip"
                      data-tone={embeddingStatusTone(p.connectionStatus)}
                    >
                      <span className="settings-pane__chip-dot" />
                      {def.name} · {embeddingModelLabel(def, p.selectedModel)}
                    </span>
                  );
                })}
            </div>
          )}

          {/* Provider rows */}
          <div className="settings-pane__embedding-scroll">
            {EMBEDDING_PROVIDERS.map((def) => {
              const provStatus = settings.providers.find(
                (p) => p.providerId === def.id,
              );
              const enabled = provStatus?.enabled ?? false;
              const isSelected = selectedProviderId === def.id;
              const dotTone = embeddingDotTone(
                provStatus ?? {
                  providerId: def.id,
                  enabled: false,
                  selectedModel: null,
                  connectionStatus: "disconnected",
                  priorityOrder: 99,
                },
              );
              const isLocalOnlyBlocked =
                settings.localOnlyMode && !def.isLocal;
              const priorityIdx = settings.providers
                .filter((p) => p.enabled)
                .sort((a, b) => a.priorityOrder - b.priorityOrder)
                .findIndex((p) => p.providerId === def.id);

              return (
                <div
                  key={def.id}
                  className="settings-pane__embedding-item"
                  data-active={isSelected ? "true" : "false"}
                  data-on={enabled ? "true" : "false"}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedProviderId(def.id)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    setSelectedProviderId(def.id);
                  }}
                >
                  <div className="settings-pane__embedding-item-row">
                    {/* Status dot */}
                    <span
                      className="settings-pane__nav-list-item-dot"
                      data-tone={dotTone}
                      aria-hidden
                    />
                    {/* Icon */}
                    <Icon
                      icon={def.icon}
                      width={14}
                      height={14}
                      className="settings-pane__embedding-item-icon"
                    />
                    {/* Name */}
                    <span className="settings-pane__embedding-item-name">
                      {def.name}
                    </span>
                    {/* Priority badge for enabled providers */}
                    {enabled && priorityIdx >= 0 && (
                      <span className="settings-pane__embedding-priority-badge">
                        #{priorityIdx + 1}
                      </span>
                    )}
                    {/* Local badge */}
                    {def.isLocal && (
                      <span className="settings-pane__embedding-local-badge">
                        local
                      </span>
                    )}
                    {/* Toggle */}
                    <button
                      type="button"
                      className="settings-pane__switch settings-pane__switch--mini"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`${enabled ? "Disable" : "Enable"} ${def.name} embeddings`}
                      data-on={enabled ? "true" : "false"}
                      disabled={isLocalOnlyBlocked}
                      title={
                        isLocalOnlyBlocked
                          ? "Local-only mode is active — only local providers can be enabled"
                          : undefined
                      }
                      onKeyDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleEnabled(def.id);
                      }}
                    >
                      <span className="settings-pane__switch-thumb" />
                    </button>
                  </div>
                  {/* Model sub-label */}
                  {enabled && provStatus?.selectedModel && (
                    <span className="settings-pane__embedding-item-model">
                      {embeddingModelLabel(def, provStatus.selectedModel)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Right — detail panel */}
        <div className="settings-pane__embedding-detail-pane">
          {selectedDef && selectedStatus != null ? (
            <EmbeddingProviderDetail
              def={selectedDef}
              status={selectedStatus}
              busy={busyProviderId === selectedDef.id}
              localOnlyMode={settings.localOnlyMode}
              openAiConnected={openAiConnected}
              mistralConnected={mistralConnected}
              googleConnected={googleConnected}
              enabledProviders={settings.providers
                .filter((p) => p.enabled)
                .sort((a, b) => a.priorityOrder - b.priorityOrder)}
              onToggleEnabled={onToggleEnabled}
              onSelectModel={onSelectModel}
              onSaveApiKey={onSaveApiKey}
              onClearApiKey={onClearApiKey}
              onSetBudgetCap={onSetBudgetCap}
              onReindex={onReindex}
              onMovePriority={onMovePriority}
            />
          ) : selectedDef ? (
            <EmbeddingProviderDetail
              def={selectedDef}
              status={{
                providerId: selectedDef.id,
                enabled: false,
                selectedModel: selectedDef.models[0]?.id ?? null,
                connectionStatus: "disconnected",
                priorityOrder: 99,
              }}
              busy={busyProviderId === selectedDef.id}
              localOnlyMode={settings.localOnlyMode}
              openAiConnected={openAiConnected}
              mistralConnected={mistralConnected}
              googleConnected={googleConnected}
              enabledProviders={settings.providers
                .filter((p) => p.enabled)
                .sort((a, b) => a.priorityOrder - b.priorityOrder)}
              onToggleEnabled={onToggleEnabled}
              onSelectModel={onSelectModel}
              onSaveApiKey={onSaveApiKey}
              onClearApiKey={onClearApiKey}
              onSetBudgetCap={onSetBudgetCap}
              onReindex={onReindex}
              onMovePriority={onMovePriority}
            />
          ) : (
            <div className="settings-pane__empty settings-pane__empty--main">
              <Icon icon="solar:layers-minimalistic-linear" width={22} height={22} />
              <span className="settings-pane__empty-title">No provider selected</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Provider detail panel
// ---------------------------------------------------------------------------

type EmbeddingProviderDetailProps = {
  def: EmbeddingProviderDefinition;
  status: EmbeddingProviderStatus;
  busy: boolean;
  localOnlyMode: boolean;
  openAiConnected: boolean;
  mistralConnected: boolean;
  googleConnected: boolean;
  enabledProviders: EmbeddingProviderStatus[];
  onToggleEnabled: (providerId: string) => void;
  onSelectModel: (providerId: string, modelId: string) => void;
  onSaveApiKey: (providerId: string, apiKey: string) => void;
  onClearApiKey: (providerId: string) => void;
  onSetBudgetCap: (providerId: string, cap: number | null) => void;
  onReindex: (providerId: string) => void;
  onMovePriority: (providerId: string, direction: "up" | "down") => void;
};

function EmbeddingProviderDetail({
  def,
  status,
  busy,
  localOnlyMode,
  openAiConnected,
  mistralConnected,
  googleConnected,
  enabledProviders,
  onToggleEnabled,
  onSelectModel,
  onSaveApiKey,
  onClearApiKey,
  onSetBudgetCap,
  onReindex,
  onMovePriority,
}: EmbeddingProviderDetailProps) {
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState(
    status.budgetCap !== null && status.budgetCap !== undefined
      ? String(status.budgetCap)
      : "",
  );
  const [confirmReindex, setConfirmReindex] = useState(false);

  // Reset drafts when provider changes
  useEffect(() => {
    setApiKeyDraft("");
    setApiKeyVisible(false);
    setBudgetDraft(
      status.budgetCap !== null && status.budgetCap !== undefined
        ? String(status.budgetCap)
        : "",
    );
    setConfirmReindex(false);
  }, [def.id, status.budgetCap]);

  // Auto-cancel confirm-reindex after 3 s
  useEffect(() => {
    if (!confirmReindex) return;
    const id = window.setTimeout(() => setConfirmReindex(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirmReindex]);

  const connected = status.connectionStatus === "connected";
  const statusLabel = embeddingStatusLabel(
    status.connectionStatus,
    status.enabled,
  );
  const statusTone = status.enabled
    ? embeddingStatusTone(status.connectionStatus)
    : "off";

  // Determine if the provider reuses credentials from another section
  const reuseSource = def.credentialsSource;
  const reuseConnected =
    reuseSource === "openai"
      ? openAiConnected
      : reuseSource === "mistral"
        ? mistralConnected
        : reuseSource === "google"
          ? googleConnected
          : reuseSource === "ollama"
            ? true // Ollama is always local, no key needed
            : false;

  const needsApiKey = !reuseSource && !status.tokenConfigured;
  const isLocalOnlyBlocked = localOnlyMode && !def.isLocal;

  // Priority helpers
  const priorityIdx = enabledProviders.findIndex(
    (p) => p.providerId === def.id,
  );
  const canMoveUp = priorityIdx > 0;
  const canMoveDown =
    priorityIdx >= 0 && priorityIdx < enabledProviders.length - 1;

  const saveApiKey = () => {
    const key = apiKeyDraft.trim();
    if (!key) return;
    onSaveApiKey(def.id, key);
    setApiKeyDraft("");
    setApiKeyVisible(false);
  };

  const saveBudget = () => {
    const val = parseFloat(budgetDraft);
    onSetBudgetCap(def.id, Number.isFinite(val) && val > 0 ? val : null);
  };

  const handleReindex = () => {
    if (!confirmReindex) {
      setConfirmReindex(true);
      return;
    }
    setConfirmReindex(false);
    onReindex(def.id);
  };

  return (
    <div className="settings-pane__embedding-detail">
      {/* ── Head ── */}
      <div className="settings-pane__embedding-detail-head">
        <div className="settings-pane__embedding-detail-title-row">
          <span className="settings-pane__provider-mark" aria-hidden>
            <Icon icon={def.icon} width={24} height={24} />
          </span>
          <div>
            <div className="settings-pane__detail-title">{def.name}</div>
            <div className="settings-pane__embedding-detail-desc">
              {def.description}
            </div>
          </div>
        </div>
        <div className="settings-pane__embedding-detail-chips">
          <span
            className="settings-pane__chip"
            data-tone={statusTone}
          >
            <span className="settings-pane__chip-dot" />
            {statusLabel}
          </span>
          {def.isLocal && (
            <span className="settings-pane__chip" data-tone="pending">
              Local
            </span>
          )}
          {reuseSource && reuseConnected && (
            <span className="settings-pane__chip" data-tone="ok">
              <span className="settings-pane__chip-dot" />
              Credentials reused
            </span>
          )}
          {reuseSource && !reuseConnected && (
            <span className="settings-pane__chip" data-tone="error">
              Connect {def.credentialsSource === "openai" ? "OpenAI" : def.credentialsSource === "mistral" ? "Mistral" : "Google"} first
            </span>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="settings-pane__embedding-detail-body">

        {/* Local-only blocked warning */}
        {isLocalOnlyBlocked && (
          <div className="settings-pane__database-warning">
            <Icon icon="solar:home-wifi-linear" width={14} height={14} />
            <span>
              Local-only mode is active. Disable it to use {def.name}.
            </span>
          </div>
        )}

        {/* Enable toggle block */}
        <div className="settings-pane__database-block">
          <div className="settings-pane__tool-group-head">
            <h2>Status</h2>
          </div>
          <div className="settings-pane__embedding-enable-row">
            <label className="settings-pane__embedding-enable-label">
              <span>Enable {def.name} for semantic search</span>
              <button
                type="button"
                className="settings-pane__switch"
                role="switch"
                aria-checked={status.enabled}
                data-on={status.enabled ? "true" : "false"}
                disabled={isLocalOnlyBlocked || busy}
                onClick={() => onToggleEnabled(def.id)}
              >
                <span className="settings-pane__switch-thumb" />
              </button>
            </label>
            {status.enabled && (
              <div className="settings-pane__embedding-priority-row">
                <span className="settings-pane__muted">
                  Priority #{priorityIdx + 1}
                </span>
                <button
                  type="button"
                  className="settings-pane__icon-btn"
                  onClick={() => onMovePriority(def.id, "up")}
                  disabled={!canMoveUp || busy}
                  title="Increase priority (move up)"
                  aria-label="Move up in priority"
                >
                  <Icon icon="solar:alt-arrow-up-linear" width={13} height={13} />
                </button>
                <button
                  type="button"
                  className="settings-pane__icon-btn"
                  onClick={() => onMovePriority(def.id, "down")}
                  disabled={!canMoveDown || busy}
                  title="Decrease priority (move down)"
                  aria-label="Move down in priority"
                >
                  <Icon icon="solar:alt-arrow-down-linear" width={13} height={13} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Credentials block */}
        {!reuseSource && (
          <div className="settings-pane__database-block">
            <div className="settings-pane__tool-group-head">
              <h2>API Key</h2>
              <span>Stored encrypted in the Claake keychain</span>
            </div>
            {status.tokenConfigured && (
              <div className="settings-pane__database-summary">
                <span className="settings-pane__chip" data-tone="ok">
                  <span className="settings-pane__chip-dot" />
                  Key saved{status.tokenPreview ? ` (${status.tokenPreview})` : ""}
                </span>
              </div>
            )}
            {status.error && (
              <div className="settings-pane__provider-error">{status.error}</div>
            )}
            <label className="settings-pane__tool-credential">
              <span className="settings-pane__tool-credential-label">
                {def.tokenEnvHint ?? "API Key"}
              </span>
              <div className="settings-pane__tool-credential-field">
                <input
                  type={apiKeyVisible ? "text" : "password"}
                  value={apiKeyDraft}
                  placeholder={
                    status.tokenConfigured
                      ? "Stored securely — paste a new key to replace"
                      : `Paste your ${def.tokenEnvHint ?? "API key"}`
                  }
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveApiKey();
                  }}
                />
                <div className="settings-pane__tool-credential-actions">
                  <button
                    type="button"
                    className="settings-pane__icon-btn"
                    onClick={() => setApiKeyVisible((v) => !v)}
                    disabled={!apiKeyDraft}
                    title={apiKeyVisible ? "Hide key" : "Show key"}
                    aria-label={apiKeyVisible ? "Hide key" : "Show key"}
                  >
                    <Icon
                      icon={
                        apiKeyVisible
                          ? "solar:eye-closed-linear"
                          : "solar:eye-linear"
                      }
                      width={13}
                      height={13}
                    />
                  </button>
                </div>
              </div>
            </label>
            <div className="settings-pane__prod-auth-actions">
              <button
                type="button"
                className="settings-pane__btn"
                data-primary="true"
                onClick={saveApiKey}
                disabled={busy || apiKeyDraft.trim().length === 0}
              >
                <Icon
                  icon={busy ? "solar:refresh-linear" : "solar:diskette-linear"}
                  width={13}
                  height={13}
                />
                <span>{busy ? "Saving…" : "Save key"}</span>
              </button>
              {status.tokenConfigured && (
                <button
                  type="button"
                  className="settings-pane__btn"
                  onClick={() => onClearApiKey(def.id)}
                  disabled={busy}
                >
                  <Icon icon="solar:trash-bin-trash-linear" width={13} height={13} />
                  <span>Clear key</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Reuse-credentials info block */}
        {reuseSource && (
          <div className="settings-pane__database-block">
            <div className="settings-pane__tool-group-head">
              <h2>Credentials</h2>
            </div>
            <div className="settings-pane__database-help">
              <Icon icon="solar:key-minimalistic-linear" width={14} height={14} />
              <span>
                {reuseSource === "ollama" ? (
                  <>
                    No credentials needed. Ollama runs locally and uses the
                    endpoint already configured in Settings → Providers.
                  </>
                ) : (
                  <>
                    This provider reuses the{" "}
                    <strong>
                      {reuseSource === "openai"
                        ? "OpenAI"
                        : reuseSource === "mistral"
                          ? "Mistral"
                          : "Google"}
                    </strong>{" "}
                    credentials you already configured in{" "}
                    <strong>Settings → Providers</strong>. No additional key
                    required.
                  </>
                )}
              </span>
            </div>
          </div>
        )}

        {/* Model selector */}
        <div className="settings-pane__database-block">
          <div className="settings-pane__tool-group-head">
            <h2>Model</h2>
            {status.selectedModel && (
              <span>
                {(() => {
                  const m = def.models.find(
                    (mo) => mo.id === status.selectedModel,
                  );
                  return m ? `${m.dimensions}d` : "";
                })()}
              </span>
            )}
          </div>
          <div className="settings-pane__embedding-model-grid">
            {def.models.map((model) => (
              <EmbeddingModelCard
                key={model.id}
                model={model}
                selected={status.selectedModel === model.id}
                onSelect={() => onSelectModel(def.id, model.id)}
              />
            ))}
          </div>
        </div>

        {/* Budget cap */}
        {!def.isLocal && (
          <div className="settings-pane__database-block">
            <div className="settings-pane__tool-group-head">
              <h2>Monthly budget cap</h2>
              <span>Provider auto-pauses when reached</span>
            </div>
            <div className="settings-pane__embedding-budget-row">
              <span className="settings-pane__embedding-budget-prefix">$</span>
              <input
                className="settings-pane__input settings-pane__embedding-budget-input"
                type="number"
                min={0}
                step={1}
                value={budgetDraft}
                placeholder="No cap"
                onChange={(e) => setBudgetDraft(e.target.value)}
              />
              <button
                type="button"
                className="settings-pane__btn"
                onClick={saveBudget}
                disabled={busy}
              >
                <Icon icon="solar:diskette-linear" width={13} height={13} />
                <span>Set cap</span>
              </button>
              {status.budgetCap !== null && status.budgetCap !== undefined && (
                <button
                  type="button"
                  className="settings-pane__btn"
                  onClick={() => {
                    setBudgetDraft("");
                    onSetBudgetCap(def.id, null);
                  }}
                  disabled={busy}
                >
                  <Icon icon="solar:close-circle-linear" width={13} height={13} />
                  <span>Remove cap</span>
                </button>
              )}
            </div>
            {status.budgetCap !== null && status.budgetCap !== undefined && (
              <div className="settings-pane__muted">
                Auto-pause above ${status.budgetCap}/month
              </div>
            )}
          </div>
        )}

        {/* Re-index */}
        <div className="settings-pane__database-block">
          <div className="settings-pane__tool-group-head">
            <h2>Index</h2>
            <span>On-demand — only changed chunks are recomputed</span>
          </div>
          <div className="settings-pane__database-help">
            <Icon icon="solar:info-circle-linear" width={14} height={14} />
            <span>
              Indexing runs lazily when the agent needs semantic context.
              Use "Re-index now" to warm the cache for the current workspace.
            </span>
          </div>
          <div className="settings-pane__prod-auth-actions">
            <button
              type="button"
              className="settings-pane__btn"
              data-primary={confirmReindex ? "true" : undefined}
              data-danger={confirmReindex ? "true" : undefined}
              onClick={handleReindex}
              disabled={busy || !status.enabled}
              title={
                !status.enabled
                  ? "Enable this provider first"
                  : "Re-index the workspace using this embedding provider"
              }
            >
              <Icon
                icon={
                  busy
                    ? "solar:refresh-linear"
                    : "solar:layers-minimalistic-linear"
                }
                width={13}
                height={13}
              />
              <span>
                {busy
                  ? "Indexing…"
                  : confirmReindex
                    ? "Confirm re-index?"
                    : "Re-index now"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model card
// ---------------------------------------------------------------------------

function EmbeddingModelCard({
  model,
  selected,
  onSelect,
}: {
  model: EmbeddingModel;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="settings-pane__embedding-model-card"
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="settings-pane__embedding-model-name">{model.label}</span>
      {model.dimensions > 0 && (
        <span className="settings-pane__embedding-model-dim">
          {model.dimensions}d
        </span>
      )}
      {model.description && (
        <span className="settings-pane__embedding-model-desc">
          {model.description}
        </span>
      )}
    </button>
  );
}
