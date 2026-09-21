import { useState } from "react";
import { Icon } from "@iconify/react";
import type { TypeSafeSettings } from "../types";

type Props = {
  settings: TypeSafeSettings | null;
  loading: boolean;
  saving: boolean;
  status: string | null;
  onRefresh: () => void;
  onSave: (token: string) => void;
  onClear: () => void;
};

export function TypeSafeSection({ settings, loading, saving, status, onRefresh, onSave, onClear }: Props) {
  const [token, setToken] = useState("");
  const configured = settings?.hasToken ?? false;

  return (
    <div className="settings-pane__body settings-pane__body--prod">
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h2 className="settings-pane__title">TypeSafe / Jev</h2>
          <p className="settings-pane__subtitle">
            Optional API key for building software with TypeSafe System One models. Claake Code stores it locally but never uses it automatically.
          </p>
        </div>
        <button type="button" className="settings-pane__btn" disabled={loading || saving} onClick={onRefresh}>
          <Icon icon="solar:refresh-linear" width={16} /> Refresh
        </button>
      </header>

      <div className="settings-pane__database-block">
        <div className="settings-pane__detail-head">
          <div>
            <div className="settings-pane__detail-title">API key</div>
            <p className="settings-pane__database-help">
              {configured ? `Configured (${settings?.tokenPreview ?? "masked"}). The raw key is never displayed.` : "Not configured. Get a key from the TypeSafe console."}
            </p>
          </div>
          <span className="settings-pane__chip">
            <span className="settings-pane__chip-dot" data-active={configured ? "true" : "false"} />
            {configured ? "Configured" : "Optional"}
          </span>
        </div>

        <div className="settings-pane__prod-form">
          <label className="settings-pane__tool-credential">
            <span>TypeSafe API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={configured ? "Paste a new key to replace the saved one" : "Paste your TypeSafe API key"}
              value={token}
              disabled={saving}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <div className="settings-pane__actions">
            <button
              type="button"
              className="settings-pane__btn settings-pane__btn--primary"
              disabled={saving || token.trim().length === 0}
              onClick={() => { onSave(token); setToken(""); }}
            >
              {saving ? "Saving…" : configured ? "Replace key" : "Save key"}
            </button>
            {configured ? <button type="button" className="settings-pane__btn" disabled={saving} onClick={onClear}>Remove key</button> : null}
            <a className="settings-pane__btn" href={settings?.consoleUrl ?? "https://console.typesafe.ai/keys"} target="_blank" rel="noreferrer">Get a key</a>
            <a className="settings-pane__btn" href={settings?.docsUrl ?? "https://docs.typesafe.ai"} target="_blank" rel="noreferrer">Documentation</a>
          </div>
        </div>

        <p className="settings-pane__database-help">
          Stored in a separate local file with Unix 0600 permissions. It is not encrypted at rest and is not injected into terminals, tools, or agent runs.
        </p>
        {status ? <p className="settings-pane__status">{status}</p> : null}
      </div>
    </div>
  );
}
