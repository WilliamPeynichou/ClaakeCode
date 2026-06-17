import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import type {
  ProdProviderAction,
  ProdProviderDefinition,
  ProdProviderRuntimeStatus,
  ProdSettings,
} from "../types";
import {
  prodAuthLabel,
  prodAuthTone,
  prodCliLabel,
  prodCliTone,
  prodConnectedCount,
  prodErrorMessage,
  prodProviderDotTone,
  prodStatusForProvider,
} from "../lib/prodSettings";

export type ProdSectionProps = {
  providers: ProdProviderDefinition[];
  settings: ProdSettings;
  loading: boolean;
  busyProviderId: string | null;
  tokenSavingProviderId: string | null;
  status: string | null;
  onRefresh: () => void;
  onConnect: (providerId: string, tokenDraft?: string) => void;
  onDisconnect: (providerId: string) => void;
  onSaveToken: (providerId: string, token: string) => void;
  onClearToken: (providerId: string) => void;
  onRunAction: (provider: ProdProviderDefinition, action: ProdProviderAction) => void;
  onOpenInstallUrl: (url: string) => void;
};

export function ProdSection({
  providers,
  settings,
  loading,
  busyProviderId,
  tokenSavingProviderId,
  status,
  onRefresh,
  onConnect,
  onDisconnect,
  onSaveToken,
  onClearToken,
  onRunAction,
  onOpenInstallUrl,
}: ProdSectionProps) {
  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    providers[0]?.id ?? "",
  );
  const connectedCount = prodConnectedCount(settings);
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ?? providers[0] ?? null;
  const selectedStatus = selectedProvider
    ? prodStatusForProvider(settings, selectedProvider.id)
    : null;

  useEffect(() => {
    if (providers.some((provider) => provider.id === selectedProviderId)) return;
    setSelectedProviderId(providers[0]?.id ?? "");
  }, [providers, selectedProviderId]);

  return (
    <>
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">Prod</h1>
          <p className="settings-pane__subtitle">
            {loading
              ? "Checking deployment CLIs…"
              : `${connectedCount}/${providers.length} deployment providers connected`}
          </p>
        </div>
        <div className="settings-pane__actions">
          {status && (
            <span
              className="settings-pane__status"
              data-tone={status === "Refreshed" || status === "Saved" ? "ok" : "pending"}
            >
              {status}
            </span>
          )}
          <button
            type="button"
            className="settings-pane__btn"
            onClick={onRefresh}
            disabled={loading || busyProviderId !== null}
          >
            <Icon icon="solar:refresh-linear" width={13} height={13} />
            <span>{loading ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>
      </header>

      <div className="settings-pane__body settings-pane__body--prod">
        <aside className="settings-pane__nav-list settings-pane__prod-list">
          <div className="settings-pane__nav-list-head">
            <span>Providers</span>
            <span className="settings-pane__servers-meta">
              {connectedCount}/{providers.length} connected
            </span>
          </div>
          <div className="settings-pane__nav-list-items">
            {providers.map((provider) => {
              const providerStatus = prodStatusForProvider(settings, provider.id);
              return (
                <button
                  type="button"
                  key={provider.id}
                  className="settings-pane__nav-list-item settings-pane__prod-provider-row"
                  data-active={selectedProvider?.id === provider.id ? "true" : "false"}
                  data-on={providerStatus.authStatus === "connected" ? "true" : "false"}
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  <span
                    className="settings-pane__nav-list-item-dot"
                    data-tone={prodProviderDotTone(providerStatus)}
                    aria-hidden
                  />
                  <Icon
                    icon={provider.icon}
                    width={14}
                    height={14}
                    className="settings-pane__nav-list-item-glyph"
                  />
                  <span className="settings-pane__nav-list-item-name">{provider.name}</span>
                  <span className="settings-pane__database-engine-pill">{provider.cli}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="settings-pane__detail-pane">
          {selectedProvider && selectedStatus ? (
            <ProdProviderEditor
              provider={selectedProvider}
              status={selectedStatus}
              busy={busyProviderId === selectedProvider.id}
              savingToken={tokenSavingProviderId === selectedProvider.id}
              disabled={loading}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onSaveToken={onSaveToken}
              onClearToken={onClearToken}
              onRunAction={onRunAction}
              onOpenInstallUrl={onOpenInstallUrl}
            />
          ) : (
            <div className="settings-pane__empty settings-pane__empty--main">
              <Icon icon="solar:cloud-check-linear" width={22} height={22} />
              <span className="settings-pane__empty-title">No prod providers</span>
              <span className="settings-pane__empty-sub">
                The v1 catalogue could not be loaded.
              </span>
            </div>
          )}
        </main>
      </div>
    </>
  );
}

function ProdProviderEditor({
  provider,
  status,
  busy,
  savingToken,
  disabled,
  onConnect,
  onDisconnect,
  onSaveToken,
  onClearToken,
  onRunAction,
  onOpenInstallUrl,
}: {
  provider: ProdProviderDefinition;
  status: ProdProviderRuntimeStatus;
  busy: boolean;
  savingToken: boolean;
  disabled: boolean;
  onConnect: (providerId: string, tokenDraft?: string) => void;
  onDisconnect: (providerId: string) => void;
  onSaveToken: (providerId: string, token: string) => void;
  onClearToken: (providerId: string) => void;
  onRunAction: (provider: ProdProviderDefinition, action: ProdProviderAction) => void;
  onOpenInstallUrl: (url: string) => void;
}) {
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [confirmActionId, setConfirmActionId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const connected = status.authStatus === "connected";
  const cliMissing = status.cliStatus === "missing";
  const tokenSupported = Boolean(provider.tokenEnvVar);
  const authModes = useMemo(
    () => provider.authModes.map((mode) => (mode === "oauth" ? "OAuth/browser" : "Token")).join(" + "),
    [provider.authModes],
  );
  const error = localError ?? status.error;

  useEffect(() => {
    setTokenDraft("");
    setTokenVisible(false);
    setConfirmActionId(null);
    setLocalError(null);
  }, [provider.id]);

  useEffect(() => {
    if (!confirmActionId) return;
    const id = window.setTimeout(() => setConfirmActionId(null), 3500);
    return () => window.clearTimeout(id);
  }, [confirmActionId]);

  const saveToken = () => {
    const token = tokenDraft.trim();
    if (!token) return;
    onSaveToken(provider.id, token);
    setTokenDraft("");
    setTokenVisible(false);
  };

  const connect = () => {
    const draft = tokenDraft.trim();
    onConnect(provider.id, draft || undefined);
    if (draft) {
      setTokenDraft("");
      setTokenVisible(false);
    }
  };

  const runAction = (action: ProdProviderAction) => {
    if (action.requiresConfirmation && confirmActionId !== action.id) {
      setConfirmActionId(action.id);
      return;
    }
    setConfirmActionId(null);
    onRunAction(provider, action);
  };

  return (
    <div className="settings-pane__detail settings-pane__prod-detail">
      <div className="settings-pane__detail-head settings-pane__prod-detail-head">
        <div className="settings-pane__prod-title">
          <span className="settings-pane__provider-mark settings-pane__prod-mark" aria-hidden>
            <Icon icon={provider.icon} width={24} height={24} />
          </span>
          <div>
            <div className="settings-pane__detail-title">{provider.name}</div>
            <div className="settings-pane__prod-subtitle">
              CLI <code>{provider.cli}</code>
              {provider.cliAliases && provider.cliAliases.length > 0
                ? ` / ${provider.cliAliases.join(" / ")}`
                : ""}
            </div>
          </div>
        </div>
        <div className="settings-pane__prod-head-actions">
          <span className="settings-pane__chip" data-tone={prodCliTone(status.cliStatus)}>
            <span className="settings-pane__chip-dot" />
            {prodCliLabel(status.cliStatus)}
          </span>
          <span className="settings-pane__chip" data-tone={prodAuthTone(status.authStatus)}>
            <span className="settings-pane__chip-dot" />
            {prodAuthLabel(status.authStatus)}
          </span>
        </div>
      </div>

      <div className="settings-pane__detail-body settings-pane__prod-form">
        <div className="settings-pane__database-help">
          <Icon icon="solar:shield-warning-linear" width={14} height={14} />
          <span>
            Login, logout and detection run in a hidden backend terminal. Quick actions are
            public commands injected into the visible terminal; tokens are never included.
          </span>
        </div>

        <div className="settings-pane__database-summary">
          <span className="settings-pane__chip" data-tone="pending">{authModes || "Best effort"}</span>
          {provider.authCheckCommand && (
            <span className="settings-pane__chip" data-tone="pending">
              Check: <code>{provider.authCheckCommand}</code>
            </span>
          )}
          {status.identity && (
            <span className="settings-pane__chip" data-tone="ok">
              <span className="settings-pane__chip-dot" />
              {status.identity}
            </span>
          )}
          {status.tokenConfigured && (
            <span className="settings-pane__chip" data-tone="ok">
              <span className="settings-pane__chip-dot" />
              Token saved{status.tokenPreview ? ` (${status.tokenPreview})` : ""}
            </span>
          )}
        </div>

        {error && (
          <div className="settings-pane__provider-error">{prodErrorMessage(error)}</div>
        )}

        {cliMissing && (
          <div className="settings-pane__database-warning settings-pane__prod-install-warning">
            <span>
              The <code>{provider.cli}</code> CLI was not detected. Install it before connecting.
            </span>
            {provider.installUrl && (
              <button
                type="button"
                className="settings-pane__btn"
                onClick={() => onOpenInstallUrl(provider.installUrl)}
              >
                <Icon icon="solar:external-link-linear" width={13} height={13} />
                <span>Install docs</span>
              </button>
            )}
          </div>
        )}

        <div className="settings-pane__database-block settings-pane__prod-auth-block">
          <div className="settings-pane__tool-group-head">
            <h2>Connection</h2>
            <span>Hidden browser/token flow</span>
          </div>
          {tokenSupported && (
            <label className="settings-pane__tool-credential settings-pane__prod-token-field">
              <span className="settings-pane__tool-credential-label">
                {provider.tokenEnvVar}
              </span>
              <div className="settings-pane__tool-credential-field">
                <input
                  type={tokenVisible ? "text" : "password"}
                  value={tokenDraft}
                  placeholder={
                    status.tokenConfigured
                      ? "Stored securely — enter a new token to replace"
                      : "Optional token / API key"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setTokenDraft(event.target.value);
                    setLocalError(null);
                  }}
                  disabled={disabled || busy || savingToken}
                />
                <div className="settings-pane__tool-credential-actions">
                  <button
                    type="button"
                    className="settings-pane__icon-btn"
                    onClick={() => setTokenVisible((current) => !current)}
                    title={tokenVisible ? "Hide token" : "Show token"}
                    aria-label={tokenVisible ? "Hide token" : "Show token"}
                    disabled={disabled || !tokenDraft}
                  >
                    <Icon
                      icon={tokenVisible ? "solar:eye-closed-linear" : "solar:eye-linear"}
                      width={13}
                      height={13}
                    />
                  </button>
                </div>
              </div>
            </label>
          )}
          <div className="settings-pane__prod-auth-actions">
            {tokenSupported && (
              <button
                type="button"
                className="settings-pane__btn"
                onClick={saveToken}
                disabled={disabled || busy || savingToken || tokenDraft.trim().length === 0}
              >
                <Icon icon={savingToken ? "solar:refresh-linear" : "solar:diskette-linear"} width={13} height={13} />
                <span>{savingToken ? "Saving…" : "Save token"}</span>
              </button>
            )}
            {status.tokenConfigured && tokenSupported && (
              <button
                type="button"
                className="settings-pane__btn"
                onClick={() => onClearToken(provider.id)}
                disabled={disabled || busy || savingToken}
              >
                <Icon icon="solar:trash-bin-trash-linear" width={13} height={13} />
                <span>Clear token</span>
              </button>
            )}
            {connected ? (
              <button
                type="button"
                className="settings-pane__btn"
                onClick={() => onDisconnect(provider.id)}
                disabled={disabled || busy}
              >
                <Icon icon="solar:logout-2-linear" width={13} height={13} />
                <span>{busy ? "Disconnecting…" : "Disconnect"}</span>
              </button>
            ) : (
              <button
                type="button"
                className="settings-pane__btn"
                data-primary="true"
                onClick={connect}
                disabled={disabled || busy || cliMissing}
              >
                <Icon icon={busy ? "solar:refresh-linear" : "solar:login-2-linear"} width={13} height={13} />
                <span>{busy ? "Connecting…" : "Connect"}</span>
              </button>
            )}
          </div>
        </div>

        <div className="settings-pane__database-block settings-pane__prod-actions-block">
          <div className="settings-pane__tool-group-head">
            <h2>Quick actions</h2>
            <span>Injected into the visible terminal</span>
          </div>
          <div className="settings-pane__prod-action-grid">
            {provider.actions.map((action) => {
              const confirming = confirmActionId === action.id;
              return (
                <button
                  type="button"
                  key={action.id}
                  className="settings-pane__btn settings-pane__prod-action"
                  data-primary={confirming ? "true" : undefined}
                  onClick={() => runAction(action)}
                  disabled={!connected || disabled || busy}
                  title={action.command}
                >
                  <Icon
                    icon={confirming ? "solar:danger-triangle-linear" : action.icon || "solar:terminal-linear"}
                    width={13}
                    height={13}
                  />
                  <span>{confirming ? "Confirm" : action.label}</span>
                </button>
              );
            })}
          </div>
          {!connected && (
            <div className="settings-pane__prod-actions-hint">
              Connect this provider to enable terminal actions.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
