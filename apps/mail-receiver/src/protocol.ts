/**
 * CASHIER-AUTH-02E E2D: the wire contract between the receiver and the acceptance harness.
 *
 * Two independent keys, two independent jobs (never reused for each other, never equal):
 *  - the RETRIEVAL key authenticates a request the harness makes to the receiver (who may ask);
 *  - the DELIVERY key authenticates the message the receiver returns (what was really received). It is the SAME key and the SAME canonical
 *    form the E2C local-spool uses (apps/api/scripts/acceptance/cashier-02/adapters/spool-envelope.ts), so a receiver-delivered message is
 *    verified by the existing `verifyMessage`, not by a second schema. The known-answer vectors in both test suites keep the two in step.
 * Only Web Crypto is used so the same code runs in the Worker and in Node.
 */
export const PROTOCOL_VERSION = 'v1';
export const MESSAGE_LIFETIME_MS = 15 * 60_000;
export const REQUEST_FRESHNESS_MS = 60_000;
export const CLAIM_PATH = '/v1/claim';
export const HEADER_TS = 'x-acc-ts';
export const HEADER_NONCE = 'x-acc-nonce';
export const HEADER_SIG = 'x-acc-sig';
export const MAX_REQUEST_BODY = 512;

export const RUN_ID = /^[a-z0-9]{4,12}$/;
export const NONCE = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface DeliveredMessage {
  to: string;
  runId: string;
  receivedAtMs: number;
  text: string;
  mac: string;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

const hmacKey = (key: string, usage: 'sign' | 'verify'): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function hmacHex(key: string, data: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), enc.encode(data)));
}

/** Constant-time check (Web Crypto verify) of a 64-hex MAC. */
export async function verifyHmacHex(key: string, data: string, macHex: string): Promise<boolean> {
  if (typeof macHex !== 'string' || !HEX64.test(macHex)) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(key, 'verify'), fromHex(macHex), enc.encode(data));
}

/** Canonical form of a delivered message: identical to the E2C spool envelope. */
export async function canonicalMessage(m: Pick<DeliveredMessage, 'to' | 'runId' | 'receivedAtMs' | 'text'>): Promise<string> {
  return ['v1', m.to.toLowerCase(), m.runId, String(m.receivedAtMs), await sha256Hex(m.text)].join('\n');
}

export async function signMessage(deliveryKey: string, m: Pick<DeliveredMessage, 'to' | 'runId' | 'receivedAtMs' | 'text'>): Promise<string> {
  return hmacHex(deliveryKey, await canonicalMessage(m));
}

export async function verifyMessage(deliveryKey: string, m: DeliveredMessage): Promise<boolean> {
  if (typeof m.to !== 'string' || typeof m.runId !== 'string' || typeof m.text !== 'string' || typeof m.receivedAtMs !== 'number' || !Number.isFinite(m.receivedAtMs)) return false;
  return verifyHmacHex(deliveryKey, await canonicalMessage(m), m.mac);
}

/** Canonical form of a retrieval request: binds method, path, time, a single-use nonce and the exact body. */
export async function canonicalRequest(r: { method: string; path: string; ts: string; nonce: string; body: string }): Promise<string> {
  return [PROTOCOL_VERSION, r.method.toUpperCase(), r.path, r.ts, r.nonce, await sha256Hex(r.body)].join('\n');
}

export async function signRequest(retrievalKey: string, r: { method: string; path: string; ts: string; nonce: string; body: string }): Promise<string> {
  return hmacHex(retrievalKey, await canonicalRequest(r));
}

export async function verifyRequest(retrievalKey: string, r: { method: string; path: string; ts: string; nonce: string; body: string }, sig: string): Promise<boolean> {
  return verifyHmacHex(retrievalKey, await canonicalRequest(r), sig);
}
