import type { ReactNode } from "react";
import type { Connection } from "../protocol/client";
import { Icon, type IconName } from "./Icon";

export function NavBar({
  title,
  subtitle,
  left,
  right,
  showTitle = true,
}: {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  showTitle?: boolean;
}) {
  return (
    <header className="navbar">
      <div className="navbar__side">{left}</div>
      <div className="navbar__title" data-visible={showTitle ? "true" : "false"}>
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="navbar__side navbar__side--right">{right}</div>
    </header>
  );
}

export function NavButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick(): void; disabled?: boolean }) {
  return (
    <button type="button" className="nav-button" onClick={onClick} disabled={disabled} aria-label={label}>
      <Icon name={icon} />
    </button>
  );
}

export function BackButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button type="button" className="back-button" onClick={onClick}>
      <Icon name="back" size={24} stroke={2.2} />
      <span>{label}</span>
    </button>
  );
}

/** Says why nothing moves: no network, relay down, or the Mac asleep. */
export function ConnectionBanner({ connection }: { connection: Connection }) {
  if (connection.mac) return null;
  const relayDown = connection.relay !== "online";
  return (
    <div className="banner" data-tone={relayDown ? "neutral" : "warning"} role="status">
      <Icon name={relayDown ? "globe" : "laptop"} size={20} />
      <div>
        <strong>{relayDown ? "Connexion…" : "Ton Mac est hors ligne"}</strong>
        <span>
          {relayDown
            ? "Vérifie ta connexion Internet."
            : "Ouvre Claake Code sur ton Mac, active Remote et garde le Mac allumé."}
        </span>
      </div>
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Chargement" />;
}

/** The Mac names new conversations in English until their first message. */
export const conversationTitle = (title: string | undefined) =>
  !title?.trim() || title === "New conversation" ? "Nouvelle conversation" : title;

export function relativeTime(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "À l'instant";
  if (minutes < 60) return `Il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Il y a ${hours} h`;
  const date = new Date(ms);
  const days = Math.floor(hours / 24);
  if (days === 1) return "Hier";
  if (days < 7) return date.toLocaleDateString("fr-FR", { weekday: "long" });
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")}`;
}
