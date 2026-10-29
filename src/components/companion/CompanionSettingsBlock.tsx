import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/ipc";
import { availableModelsForProviders, useModelCatalogVersion } from "../../lib/models";
import type { MistralModel, OpenRouterModel } from "../../types";
import {
  DEFAULT_COMPANION_SETTINGS,
  type CompanionMode,
  type CompanionSettings,
} from "./companionContract";
import {
  getCompanionSettings,
  openCompanionBubble,
  saveCompanionSettings,
} from "./companionDesktop";

/**
 * Réglages du compagnon : raccourci, mode par défaut, modèles autorisés, modèle par défaut,
 * lancement à l'ouverture de session. Persistés par le backend (companion_save_settings).
 */
export function CompanionSettingsBlock() {
  const [settings, setSettings] = useState<CompanionSettings>(DEFAULT_COMPANION_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState<string[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [mistralModels, setMistralModels] = useState<MistralModel[]>([]);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [loadedSettings, providers, models, mModels] = await Promise.all([
        getCompanionSettings(),
        api.listConfiguredModelProviders().catch(() => [] as string[]),
        api.listOpenRouterModels().catch(() => [] as OpenRouterModel[]),
        api.listMistralModels().catch(() => [] as MistralModel[]),
      ]);
      if (cancelled) return;
      setSettings(loadedSettings);
      setConfigured(providers);
      setOpenRouterModels(models);
      setMistralModels(mModels);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const catalogVersion = useModelCatalogVersion();
  const models = useMemo(
    () => availableModelsForProviders(configured, openRouterModels, mistralModels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [configured, openRouterModels, mistralModels, catalogVersion],
  );

  const persist = async (next: CompanionSettings) => {
    setMessage(null);
    const previous = settings;
    setSettings(next);
    try {
      const saved = await saveCompanionSettings(next);
      setSettings(saved);
      setMessage({ kind: "ok", text: "Réglages enregistrés." });
    } catch (err) {
      setSettings(previous);
      setMessage({ kind: "error", text: String(err) });
    }
  };

  const toggleModel = (value: string) => {
    const allowed = settings.allowedModels.includes(value)
      ? settings.allowedModels.filter((m) => m !== value)
      : [...settings.allowedModels, value];
    const defaultModel =
      settings.defaultModel && allowed.length > 0 && !allowed.includes(settings.defaultModel)
        ? null
        : settings.defaultModel;
    void persist({ ...settings, allowedModels: allowed, defaultModel });
  };

  // Liste affichée : les modèles autorisés (ou tous si la liste est vide).
  const selectableDefaults = settings.allowedModels.length
    ? models.filter((m) => settings.allowedModels.includes(m.value))
    : models;

  return (
    <section className="companion-settings">
      <h2 className="companion-settings__title">Claaky sur le bureau</h2>
      <p className="python-runtime__muted">
        Claaky reste sur le bureau. Un raccourci ou un clic ouvre sa bulle de chat : le mode Ask
        répond seul, le mode code ouvre Claake Code et lui transmet la tâche.
      </p>
      {message && (
        <p
          className={message.kind === "error" ? "python-runtime__error" : "python-runtime__muted"}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
      <div className="companion-settings__row">
        <label className="settings-pane__field-label" htmlFor="companion-shortcut">
          Raccourci global
        </label>
        <input
          id="companion-shortcut"
          className="settings-pane__field-input"
          type="text"
          spellCheck={false}
          disabled={!loaded}
          value={settings.shortcut}
          onChange={(e) => setSettings({ ...settings, shortcut: e.target.value })}
          onBlur={() => {
            if (loaded) void persist(settings);
          }}
          placeholder="Control+Alt+Space"
        />
        <span className="python-runtime__muted">Format : Control+Alt+Space (⌃ ⌥ Espace sur macOS). Ouvre ou referme Claaky.</span>
      </div>
      <div className="companion-settings__row">
        <label className="settings-pane__field-label" htmlFor="companion-default-mode">
          Mode par défaut
        </label>
        <select
          id="companion-default-mode"
          className="settings-pane__field-input"
          disabled={!loaded}
          value={settings.defaultMode}
          onChange={(e) => void persist({ ...settings, defaultMode: e.target.value as CompanionMode })}
        >
          <option value="ask">Ask (réponse autonome)</option>
          <option value="code">Code (Claake Code)</option>
        </select>
      </div>
      <div className="companion-settings__row">
        <span className="settings-pane__field-label">Modèles accessibles au compagnon</span>
        <p className="python-runtime__muted">
          Aucun coché = tous les modèles configurés sont accessibles.
        </p>
        <div className="companion-settings__models">
          {models.length === 0 && (
            <span className="python-runtime__muted">
              Configurez un fournisseur dans Réglages pour choisir des modèles.
            </span>
          )}
          {models.map((model) => (
            <label key={model.value} className="claaky-settings__toggle">
              <input
                type="checkbox"
                disabled={!loaded}
                checked={settings.allowedModels.includes(model.value)}
                onChange={() => toggleModel(model.value)}
              />
              <span>{model.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="companion-settings__row">
        <label className="settings-pane__field-label" htmlFor="companion-default-model">
          Modèle par défaut
        </label>
        <select
          id="companion-default-model"
          className="settings-pane__field-input"
          disabled={!loaded || selectableDefaults.length === 0}
          value={settings.defaultModel ?? ""}
          onChange={(e) =>
            void persist({ ...settings, defaultModel: e.target.value || null })
          }
        >
          <option value="">Modèle de Claake Code</option>
          {selectableDefaults.map((model) => (
            <option key={model.value} value={model.value}>
              {model.label}
            </option>
          ))}
        </select>
      </div>
      <div className="companion-settings__row">
        <label className="claaky-settings__toggle">
          <input
            type="checkbox"
            disabled={!loaded}
            checked={settings.launchAtLogin}
            onChange={(e) => void persist({ ...settings, launchAtLogin: e.target.checked })}
          />
          <span>Lancer Claake Code à l'ouverture de session</span>
        </label>
      </div>
      <div className="companion-settings__row">
        <button
          type="button"
          className="settings-pane__chip"
          onClick={() => {
            openCompanionBubble().catch((err) => setMessage({ kind: "error", text: String(err) }));
          }}
        >
          Ouvrir Claaky sur le bureau
        </button>
      </div>
    </section>
  );
}
