import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/index';
import type { Env } from '../../src/config';
import { CLAIM_PATH, HEADER_NONCE, HEADER_SIG, HEADER_TS, signRequest } from '../../src/protocol';
import { RETRIEVAL_KEY, bytes } from './email';

export const baseEnv = (): Env => env as Env;

export interface Delivery {
  accepted: boolean;
  rejectReason: string | null;
}

/** Hands a raw message to the Worker exactly as Email Routing does: envelope recipient, size, headers and a one-shot raw stream. */
export async function deliver(to: string, raw: string, over: Partial<Env> = {}, claimedSize?: number): Promise<Delivery> {
  let rejectReason: string | null = null;
  const data = bytes(raw);
  const message = {
    from: 'envelope-sender@example.invalid',
    to,
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } }),
    rawSize: claimedSize ?? data.byteLength,
    canBeForwarded: false,
    setReject(reason: string) { rejectReason = reason; },
    async forward() { throw new Error('the receiver must never forward mail'); },
    async reply() { throw new Error('the receiver must never reply to mail'); },
  };
  await worker.email(message as unknown as ForwardableEmailMessage, { ...baseEnv(), ...over });
  return { accepted: rejectReason === null, rejectReason };
}

export const nonce = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export interface ClaimOptions {
  key?: string;
  ts?: number;
  nonce?: string;
  body?: string;
  /** Sent instead of the signed body (tamper test). */
  sendBody?: string;
  sign?: boolean;
  method?: string;
  path?: string;
  over?: Partial<Env>;
}

/** A correctly signed (by default) claim request for one run + recipient; every field can be broken for negative tests. */
export async function claim(runId: string, recipient: string, o: ClaimOptions = {}): Promise<Response> {
  const body = o.body ?? JSON.stringify({ runId, recipient });
  const ts = String(o.ts ?? Date.now());
  const n = o.nonce ?? nonce();
  const path = o.path ?? CLAIM_PATH;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (o.sign !== false) {
    headers.set(HEADER_TS, ts);
    headers.set(HEADER_NONCE, n);
    headers.set(HEADER_SIG, await signRequest(o.key ?? RETRIEVAL_KEY, { method: 'POST', path: CLAIM_PATH, ts, nonce: n, body }));
  }
  const request = new Request(`https://receiver.test${path}`, { method: o.method ?? 'POST', headers, ...(o.method === 'GET' ? {} : { body: o.sendBody ?? body }) });
  return worker.fetch(request, { ...baseEnv(), ...(o.over ?? {}) });
}

export const get = (path: string, over: Partial<Env> = {}): Promise<Response> => worker.fetch(new Request(`https://receiver.test${path}`), { ...baseEnv(), ...over });
export const ctx = createExecutionContext;
