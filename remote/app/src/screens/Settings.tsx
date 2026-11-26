import { pushSupported, type Remote } from "../state";
import { BackButton, NavBar } from "../ui/common";
import { Icon, type IconName } from "../ui/Icon";

function Toggle({ on, onChange, disabled }: { on: boolean; onChange(next: boolean): void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="toggle" data-on={on ? "true" : "false"} disabled={disabled} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

function Row({ icon, tone, title, detail, children }: { icon: IconName; tone: string; title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className="row row--static">
      <span className="row__icon" data-tone={tone}>
        <Icon name={icon} size={18} />
      </span>
      <span className="row__text">
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </span>
      {children}
    </div>
  );
}

export function SettingsScreen({ remote, onBack }: { remote: Remote; onBack(): void }) {
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  const canPush = pushSupported() && standalone;
  const relayHost = location.host;

  return (
    <div className="screen">
      <NavBar title="Réglages" left={<BackButton label="Retour" onClick={onBack} />} />
      <div className="scroll">
        <section className="group">
          <h2 className="group__title">Mac</h2>
          <div className="group__body">
            <Row icon="laptop" tone={remote.connection.mac ? "ok" : "off"} title={remote.connection.mac ? "Connecté" : "Hors ligne"} detail={remote.connection.mac ? "Ton agent répond depuis ton Mac." : "Ouvre Claake Code sur le Mac et active Remote."} />
            <Row icon="globe" tone="folder" title="Relais" detail={relayHost} />
          </div>
        </section>

        <section className="group">
          <h2 className="group__title">Notifications</h2>
          <div className="group__body">
            <Row icon="bell" tone="bell" title="Me prévenir" detail="Quand l'agent a fini, ou attend ta réponse.">
              <Toggle
                on={remote.pushEnabled}
                disabled={!canPush || !remote.connection.mac}
                onChange={(next) => void (next ? remote.actions.enablePush() : remote.actions.disablePush())}
              />
            </Row>
          </div>
          {!canPush && <p className="group__footer">Ajoute Claake à l'écran d'accueil (Partager › Sur l'écran d'accueil) pour recevoir les notifications.</p>}
        </section>

        <section className="group">
          <h2 className="group__title">Synthèse</h2>
          <div className="group__body">
            <Row icon="speaker" tone="mode" title="Synthèse de fin de tâche" detail="L'agent termine par un court résumé.">
              <Toggle on={remote.settings.synthesis} onChange={(synthesis) => remote.actions.updateSettings({ synthesis })} />
            </Row>
            <Row icon="play" tone="mode" title="Lire à voix haute" detail="Quand une tâche finit pendant que l'app est ouverte.">
              <Toggle on={remote.settings.readAloud} disabled={!remote.settings.synthesis} onChange={(readAloud) => remote.actions.updateSettings({ readAloud })} />
            </Row>
          </div>
          <p className="group__footer">Pour dicter, touche le micro du clavier de l'iPhone.</p>
        </section>

        <section className="group">
          <h2 className="group__title">Cet iPhone</h2>
          <div className="group__body">
            <button
              type="button"
              className="row row--danger"
              onClick={() => {
                if (window.confirm("Déconnecter cet iPhone ? Il faudra l'appairer de nouveau.")) remote.actions.forget();
              }}
            >
              <span className="row__icon" data-tone="danger">
                <Icon name="close" size={18} />
              </span>
              <span className="row__text">
                <strong>Déconnecter cet iPhone</strong>
              </span>
            </button>
          </div>
          <p className="group__footer">Chiffré de bout en bout entre cet iPhone et ton Mac : le relais ne voit jamais tes messages. Pour retirer l'accès à distance, révoque l'iPhone sur le Mac.</p>
        </section>
      </div>
    </div>
  );
}
