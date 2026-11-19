import { createHash, createHmac } from 'node:crypto';

/**
 * CASHIER-AUTH-02E E2D: the harness side of the receiver's retrieval protocol (apps/mail-receiver/src/protocol.ts is the other side).
 * Same canonical form; the known-answer vector in receiver-adapter tests and in the receiver's own tests keeps them in step.
 * The retrieval key authenticates the REQUEST; the delivery key (spool-envelope.ts) authenticates the returned MESSAGE. They are independent.
 */
export const RETRIEVAL_KEY_ENV = 'ACCEPTANCE_RECEIVER_RETRIEVAL_KEY';
export const RECEIVER_HOST_ENV = 'ACCEPTANCE_MAILBOX_RECEIVER_HOST';
export const CLAIM_PATH = '/v1/claim';
export const HEADER_TS = 'x-acc-ts';
export const HEADER_NONCE = 'x-acc-nonce';
export const HEADER_SIG = 'x-acc-sig';

export const canonicalRequest = (r: { method: string; path: string; ts: string; nonce: string; body: string }): string =>
  ['v1', r.method.toUpperCase(), r.path, r.ts, r.nonce, createHash('sha256').update(r.body).digest('hex')].join('\n');

export const signRequest = (key: string, r: { method: string; path: string; ts: string; nonce: string; body: string }): string =>
  createHmac('sha256', key).update(canonicalRequest(r)).digest('hex');
