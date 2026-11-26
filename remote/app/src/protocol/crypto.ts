// Same crypto as src-tauri/src/remote.rs: ECDH P-256 pairing, then AES-256-GCM per device.
const AAD = new TextEncoder().encode("sinew-remote-v1");
const PAIRING_LABEL = "sinew-remote-pairing-v1";

export type CipherEnvelope = { nonce: string; ciphertext: string };

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  return fromBase64(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function importDeviceKey(secretB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(secretB64), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<CipherEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: AAD }, key, plaintext);
  return { nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptJson<T>(key: CryptoKey, envelope: CipherEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.nonce), additionalData: AAD },
    key,
    fromBase64(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export type PairingKeys = { keyPair: CryptoKeyPair; publicRaw: Uint8Array<ArrayBuffer> };

export async function createPairingKeys(): Promise<PairingKeys> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { keyPair, publicRaw };
}

export async function derivePairingKey(keys: PairingKeys, pcPublicB64: string, code: string): Promise<CryptoKey> {
  const pcPublicRaw = fromBase64(pcPublicB64);
  const pcPublic = await crypto.subtle.importKey("raw", pcPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: pcPublic }, keys.keyPair.privateKey, 256),
  );
  const text = new TextEncoder();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    concat(text.encode(PAIRING_LABEL), shared, pcPublicRaw, keys.publicRaw, text.encode(code)),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
}
