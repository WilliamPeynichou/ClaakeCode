/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { sendPush, type PushSubscription, type VapidConfig } from "./push";

interface Env {
  ASSETS: Fetcher;
  RELAY: DurableObjectNamespace;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT: string;
}

// Per-socket state, kept in the WebSocket attachment so it survives hibernation.
type Attachment =
  | { role: "pc"; pcId: string; code?: { code: string; expiresAtMs: number } }
  | { role: "phone"; pcId: string; deviceId: string; pairConnId?: string }
  | { role: "unknown" };

type Frame = Record<string, any>;

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...init?.headers } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true });
    if (url.pathname === "/vapid-public-key") {
      return json({ publicKey: env.VAPID_PUBLIC_KEY || null }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      return env.RELAY.get(env.RELAY.idFromName("relay")).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class Relay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"kind":"ping"}', '{"kind":"pong"}'));
  }

  async fetch(_request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: "unknown" } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    let frame: Frame;
    try {
      frame = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return send(ws, { kind: "relay_error", message: "invalid JSON frame" });
    }
    const kind = String(frame?.kind || "");
    if (kind.startsWith("pc_")) this.handlePcFrame(ws, kind, frame);
    else if (kind.startsWith("phone_")) this.handlePhoneFrame(ws, kind, frame);
    else send(ws, { kind: "relay_error", message: `unknown frame: ${kind}` });
  }

  webSocketClose(ws: WebSocket): void {
    this.cleanup(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.cleanup(ws);
  }

  private sockets(): { ws: WebSocket; att: Attachment }[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN)
      .map((ws) => ({ ws, att: (ws.deserializeAttachment() ?? { role: "unknown" }) as Attachment }));
  }

  private findPc(pcId: string): WebSocket | undefined {
    return this.sockets().find((s) => s.att.role === "pc" && s.att.pcId === pcId)?.ws;
  }

  private findPhoneByDevice(deviceId: string): WebSocket | undefined {
    return this.sockets().find((s) => s.att.role === "phone" && s.att.deviceId === deviceId)?.ws;
  }

  private cleanup(ws: WebSocket): void {
    const att = (ws.deserializeAttachment() ?? { role: "unknown" }) as Attachment;
    ws.serializeAttachment({ role: "unknown" } satisfies Attachment);
    const others = this.sockets().filter((s) => s.ws !== ws);
    if (att.role === "pc") {
      for (const s of others) {
        if (s.att.role === "phone" && s.att.pcId === att.pcId && s.att.deviceId) {
          send(s.ws, { kind: "pc_status", reachable: false });
        }
      }
    } else if (att.role === "phone" && att.deviceId) {
      const pc = others.find((s) => s.att.role === "pc" && s.att.pcId === att.pcId);
      if (pc) send(pc.ws, { kind: "phone_disconnected", device_id: att.deviceId });
    }
  }

  private handlePcFrame(ws: WebSocket, kind: string, frame: Frame): void {
    const att = (ws.deserializeAttachment() ?? { role: "unknown" }) as Attachment;
    if (kind === "pc_hello") {
      const pcId = String(frame.pc_id || "");
      if (!pcId) return;
      const older = this.findPc(pcId);
      if (older && older !== ws) {
        older.serializeAttachment({ role: "unknown" } satisfies Attachment);
        closeQuietly(older, 4000, "replaced");
      }
      ws.serializeAttachment({ role: "pc", pcId } satisfies Attachment);
      send(ws, { kind: "pc_registered", pc_id: pcId });
      for (const s of this.sockets()) {
        if (s.att.role === "phone" && s.att.pcId === pcId && s.att.deviceId) {
          send(s.ws, { kind: "pc_status", reachable: true });
          send(ws, { kind: "phone_connected", device_id: s.att.deviceId });
        }
      }
      return;
    }
    if (att.role !== "pc") return send(ws, { kind: "error", message: "pc_hello required first" });

    switch (kind) {
      case "pc_pairing_code": {
        const code = String(frame.code || "");
        if (!code) return;
        ws.serializeAttachment({ ...att, code: { code, expiresAtMs: Number(frame.expires_at_ms || 0) } });
        break;
      }
      case "pc_pair_response": {
        const phone = this.sockets().find(
          (s) => s.att.role === "phone" && s.att.pairConnId === String(frame.phone_conn_id || ""),
        );
        if (!phone) return;
        send(phone.ws, {
          kind: "pairing_response",
          accepted: Boolean(frame.accepted),
          pcPublicKey: frame.pc_public_key || null,
          encrypted: frame.encrypted || null,
          error: frame.error || null,
        });
        break;
      }
      case "pc_cipher": {
        const phone = this.findPhoneByDevice(String(frame.device_id || ""));
        if (phone) send(phone, { kind: "pc_cipher", envelope: frame.envelope });
        break;
      }
      case "pc_push":
        this.ctx.waitUntil(this.push(frame.subscription, frame.payload));
        break;
      case "pc_revoke_device": {
        const phone = this.findPhoneByDevice(String(frame.device_id || ""));
        if (phone) {
          send(phone, { kind: "device_revoked" });
          closeQuietly(phone, 4001, "device revoked");
        }
        break;
      }
      default:
        send(ws, { kind: "error", message: `unknown pc frame: ${kind}` });
    }
  }

  private handlePhoneFrame(ws: WebSocket, kind: string, frame: Frame): void {
    switch (kind) {
      case "phone_pair_request": {
        const code = String(frame.code || "").trim();
        const pc = this.sockets().find(
          (s) => s.att.role === "pc" && s.att.code?.code === code && s.att.code.expiresAtMs > Date.now(),
        );
        if (!pc) {
          return send(ws, {
            kind: "pairing_response",
            accepted: false,
            error: "Pairing code expired or not found.",
          });
        }
        const pairConnId = `phone_${randomId()}`;
        ws.serializeAttachment({ role: "phone", pcId: (pc.att as { pcId: string }).pcId, deviceId: "", pairConnId });
        send(pc.ws, {
          kind: "pairing_request",
          phone_conn_id: pairConnId,
          code,
          device_name: String(frame.deviceName || "Phone"),
          phone_public_key: String(frame.phonePublicKey || ""),
        });
        break;
      }
      case "phone_hello": {
        const pcId = String(frame.pcId || "");
        const deviceId = String(frame.deviceId || "");
        // A reconnecting phone replaces its previous socket, which is often half-open after iOS suspended the app.
        for (const s of this.sockets()) {
          if (deviceId && s.ws !== ws && s.att.role === "phone" && s.att.deviceId === deviceId) {
            s.ws.serializeAttachment({ role: "unknown" } satisfies Attachment);
            closeQuietly(s.ws, 4000, "replaced");
          }
        }
        ws.serializeAttachment({ role: "phone", pcId, deviceId } satisfies Attachment);
        const pc = this.findPc(pcId);
        send(ws, { kind: "pc_status", reachable: Boolean(pc) });
        if (pc && deviceId) send(pc, { kind: "phone_connected", device_id: deviceId });
        break;
      }
      case "phone_cipher": {
        const att = (ws.deserializeAttachment() ?? { role: "unknown" }) as Attachment;
        const pc = att.role === "phone" ? this.findPc(att.pcId) : undefined;
        if (!pc) return send(ws, { kind: "pc_status", reachable: false });
        send(pc, { kind: "phone_cipher", device_id: String(frame.deviceId || ""), envelope: frame.envelope });
        break;
      }
      default:
        send(ws, { kind: "relay_error", message: `unknown phone frame: ${kind}` });
    }
  }

  private async push(subscription: PushSubscription, payload: Frame | undefined): Promise<void> {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = this.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      console.warn("push skipped: VAPID keys are not configured");
      return;
    }
    const vapid: VapidConfig = { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT };
    try {
      await sendPush(
        subscription,
        {
          title: payload?.title || "Claake Code",
          body: payload?.body || "L'agent a terminé.",
          conversationId: payload?.conversationId || null,
          workspaceId: payload?.workspaceId || null,
        },
        vapid,
      );
    } catch (err) {
      console.warn("push delivery failed", String(err));
    }
  }
}

function send(ws: WebSocket, frame: Frame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // socket already closing
  }
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // best effort
  }
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}
