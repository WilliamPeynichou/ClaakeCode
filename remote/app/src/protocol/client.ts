import {
  createPairingKeys,
  decryptJson,
  derivePairingKey,
  encryptJson,
  importDeviceKey,
  randomId,
  toBase64,
  type CipherEnvelope,
  type PairingKeys,
} from "./crypto";
import type { PcPayload, PhoneCommand } from "./types";

const SESSION_KEY = "claake.remote.session.v1";
const PROTOCOL_VERSION = 1;
// The relay answers '{"kind":"ping"}' itself; a socket silent for longer is dead (common after sleep).
const PING_MS = 25_000;
const SILENCE_MS = 60_000;
const COMMAND_TIMEOUT_MS = 60_000;
const PAIRING_TIMEOUT_MS = 20_000;

export type Session = {
  pcId: string;
  relayUrl: string;
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  deviceSecret: string;
};

export type Connection = {
  relay: "connecting" | "online" | "offline";
  /** The Mac is connected to the relay. */
  mac: boolean;
};

type Listener = {
  connection(connection: Connection): void;
  payload(payload: PcPayload): void;
  revoked(): void;
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

type RelayFrame =
  | { kind: "pong" }
  | { kind: "pc_status"; reachable: boolean }
  | { kind: "device_revoked" }
  | { kind: "pairing_response"; accepted: boolean; pcPublicKey?: string; encrypted?: CipherEnvelope; error?: string }
  | { kind: "pc_cipher"; envelope: CipherEnvelope }
  | { kind: "relay_error"; message: string };

type Response = { type: "response"; request_id: string; ok: boolean; data?: unknown; error?: string | null };

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

const PAIRING_ERRORS: Record<string, string> = {
  "invalid pairing code": "Code incorrect.",
  "pairing is not open": "L'appairage n'est pas ouvert sur le Mac.",
  "pairing is temporarily locked": "Trop d'essais. Réessaie dans une minute.",
  "Pairing code expired or not found.": "Code expiré ou inconnu. Ouvre un nouvel appairage sur le Mac.",
  "PC unreachable.": "Le Mac n'est pas joignable.",
};

function wsUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export class RemoteClient {
  session: Session | null = loadSession();
  connection: Connection = { relay: "connecting", mac: false };
  private key: CryptoKey | null = null;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private pairing: { keys: PairingKeys; code: string; done: Pending } | null = null;
  private lastHeard = 0;
  private retryDelay = 1_000;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private stopped = false;

  constructor(private listener: Listener) {}

  async start() {
    if (this.session) this.key = await importDeviceKey(this.session.deviceSecret);
    this.connect();
    this.pingTimer = window.setInterval(() => this.keepAlive(), PING_MS);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.reconnectNow);
  }

  stop() {
    this.stopped = true;
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.retryTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.reconnectNow);
    this.ws?.close();
  }

  /** Forgets this phone's pairing (the Mac keeps it until revoked there). */
  forget() {
    localStorage.removeItem(SESSION_KEY);
    this.session = null;
    this.key = null;
    this.update({ mac: false });
  }

  pair(code: string, deviceName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pairing = null;
        reject(new Error("Le Mac n'a pas répondu. Vérifie que l'appairage est ouvert."));
      }, PAIRING_TIMEOUT_MS);
      const done: Pending = {
        resolve: () => {
          window.clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      };
      void createPairingKeys().then((keys) => {
        this.pairing = { keys, code, done };
        const sent = this.send({ kind: "phone_pair_request", code, deviceName, phonePublicKey: toBase64(keys.publicRaw) });
        if (!sent) {
          this.pairing = null;
          done.reject(new Error("Pas de connexion. Vérifie ta connexion Internet."));
        }
      }, done.reject);
    });
  }

  async command<T>(command: PhoneCommand, workspace?: string | null): Promise<T> {
    const session = this.session;
    if (!session || !this.key) throw new Error("Cet iPhone n'est relié à aucun Mac.");
    const requestId = randomId("req");
    const envelope = await encryptJson(this.key, {
      requestId,
      token: session.deviceToken,
      workspace: workspace ?? undefined,
      command,
    });
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Le Mac ne répond pas."));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      if (!this.send({ kind: "phone_cipher", deviceId: session.deviceId, envelope })) {
        this.pending.get(requestId)?.reject(new Error("Pas de connexion au Mac."));
        this.pending.delete(requestId);
      }
    });
  }

  private connect() {
    if (this.stopped) return;
    window.clearTimeout(this.retryTimer);
    const previous = this.ws;
    this.ws = null;
    previous?.close();
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    this.update({ relay: "connecting" });
    ws.onopen = () => {
      this.retryDelay = 1_000;
      this.lastHeard = Date.now();
      this.update({ relay: "online" });
      this.announce();
    };
    ws.onmessage = (event) => {
      this.lastHeard = Date.now();
      void this.onFrame(JSON.parse(String(event.data)) as RelayFrame).catch((error) => console.warn(error));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.update({ relay: "offline", mac: false });
      for (const pending of this.pending.values()) pending.reject(new Error("Connexion perdue."));
      this.pending.clear();
      // 4000: another window with this pairing took over. Reconnecting at once would make them evict each
      // other in a loop, so this one waits until it is shown again.
      if (this.stopped || event.code === 4000) return;
      this.retryTimer = window.setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
    };
  }

  private reconnectNow = () => {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.retryDelay = 1_000;
      this.connect();
    }
  };

  private onVisibility = () => {
    if (document.visibilityState === "visible") {
      // iOS freezes the page in the background: the socket is often dead when we come back.
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastHeard > PING_MS) this.connect();
      else this.reconnectNow();
    }
    this.sendPresence();
  };

  private keepAlive() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastHeard > SILENCE_MS) {
      this.connect();
      return;
    }
    this.ws.send('{"kind":"ping"}');
  }

  private announce() {
    if (!this.session) return;
    this.send({ kind: "phone_hello", pcId: this.session.pcId, deviceId: this.session.deviceId, protocolVersion: PROTOCOL_VERSION });
  }

  private sendPresence() {
    if (!this.connection.mac) return;
    void this.command({ type: "presence", visible: document.visibilityState === "visible" }).catch(() => undefined);
  }

  private send(frame: object): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private update(patch: Partial<Connection>) {
    this.connection = { ...this.connection, ...patch };
    this.listener.connection(this.connection);
  }

  private async onFrame(frame: RelayFrame) {
    switch (frame.kind) {
      case "pc_status":
        this.update({ mac: frame.reachable && Boolean(this.session) });
        if (frame.reachable) this.sendPresence();
        return;
      case "device_revoked":
        this.forget();
        this.listener.revoked();
        return;
      case "pairing_response":
        return this.onPairingResponse(frame);
      case "pc_cipher": {
        if (!this.key) return;
        const payload = await decryptJson<Response | PcPayload>(this.key, frame.envelope);
        if (payload.type !== "response") {
          this.listener.payload(payload);
          return;
        }
        const pending = this.pending.get(payload.request_id);
        if (!pending) return;
        this.pending.delete(payload.request_id);
        if (payload.ok) pending.resolve(payload.data);
        else pending.reject(new Error(payload.error || "Le Mac a refusé la demande."));
        return;
      }
      case "relay_error":
        console.warn("relay:", frame.message);
        return;
    }
  }

  private async onPairingResponse(frame: Extract<RelayFrame, { kind: "pairing_response" }>) {
    const pairing = this.pairing;
    if (!pairing) return;
    this.pairing = null;
    if (!frame.accepted || !frame.pcPublicKey || !frame.encrypted) {
      pairing.done.reject(new Error(PAIRING_ERRORS[frame.error ?? ""] ?? frame.error ?? "Appairage refusé."));
      return;
    }
    try {
      const pairingKey = await derivePairingKey(pairing.keys, frame.pcPublicKey, pairing.code);
      const grant = await decryptJson<Session>(pairingKey, frame.encrypted);
      this.session = {
        pcId: grant.pcId,
        relayUrl: grant.relayUrl,
        deviceId: grant.deviceId,
        deviceName: grant.deviceName,
        deviceToken: grant.deviceToken,
        deviceSecret: grant.deviceSecret,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
      this.key = await importDeviceKey(this.session.deviceSecret);
      this.announce();
      pairing.done.resolve(undefined);
    } catch {
      pairing.done.reject(new Error("Réponse du Mac illisible. Recommence l'appairage."));
    }
  }
}
