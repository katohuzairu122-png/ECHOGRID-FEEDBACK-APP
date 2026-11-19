import { loadConfig, type Env } from './config';
import { MailboxDurableObject, IngestLimiterDurableObject } from './mailbox-do';
import { inspectMessage, readBounded, type RejectReason } from './message';
import {
  CLAIM_PATH,
  HEADER_NONCE,
  HEADER_SIG,
  HEADER_TS,
  MAX_REQUEST_BODY,
  NONCE,
  REQUEST_FRESHNESS_MS,
  RUN_ID,
  sha256Hex,
  signMessage,
  verifyRequest,
  type DeliveredMessage,
} from './protocol';
import { parseRecipient } from './recipient';

export { MailboxDurableObject, IngestLimiterDurableObject };

/**
 * CASHIER-AUTH-02E E2D: the test-only acceptance mail receiver.
 *
 * Two entry points and nothing else:
 *  - `email()`: Cloudflare Email Routing delivers a message here. It is kept only if it is addressed to an exact synthetic recipient on the
 *    approved test domain, passes Cloudflare's DMARC verdict from an approved sender, is fresh, and carries exactly one confirmation link.
 *  - `fetch()`: `POST /v1/claim` (authenticated, replay-protected, single use) and `GET /health`. There is no listing, search or public inbox.
 * Logging (console.warn, one JSON line per event) is limited to a reason code and a short hash of the recipient: never a body, link, proof, key or address.
 */
const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

const UNAVAILABLE = () => json(503, { error: 'unavailable' });
const UNAUTHORIZED = () => json(401, { error: 'unauthorized' });

async function log(event: string, fields: { reason?: string; recipient?: string; size?: number } = {}): Promise<void> {
  const recipient = fields.recipient ? (await sha256Hex(fields.recipient)).slice(0, 12) : undefined;
  console.warn(JSON.stringify({ event, ...(fields.reason ? { reason: fields.reason } : {}), ...(recipient ? { recipient } : {}), ...(fields.size !== undefined ? { size: fields.size } : {}) }));
}

async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const reject = async (reason: RejectReason | 'config' | 'recipient' | 'limited' | 'full' | 'duplicate' | 'error', recipient?: string, size?: number): Promise<void> => {
    await log('rejected', { reason, ...(recipient ? { recipient } : {}), ...(size !== undefined ? { size } : {}) });
    message.setReject('Message not accepted');
  };
  try {
    const cfg = loadConfig(env);
    if (!cfg) return await reject('config');
    // The envelope recipient (RCPT TO) is what Cloudflare routed on; the To header is never consulted.
    const recipient = parseRecipient(message.to, cfg.recipientDomain);
    if (!recipient) return await reject('recipient');
    if (message.rawSize > cfg.maxRawBytes) return await reject('too_large', recipient.address, message.rawSize);
    const raw = await readBounded(message.raw, cfg.maxRawBytes);
    if (!raw) return await reject('too_large', recipient.address);
    const nowMs = Date.now();
    const inspected = await inspectMessage(raw, cfg, nowMs);
    if (!inspected.ok) return await reject(inspected.reason, recipient.address, raw.byteLength);
    const admitted = await env.INGEST_LIMITER.get(env.INGEST_LIMITER.idFromName('ingest')).admit(cfg.ingestLimit, nowMs);
    if (!admitted) return await reject('limited', recipient.address);
    const box = env.MAILBOX.get(env.MAILBOX.idFromName(recipient.address));
    const result = await box.put({ to: recipient.address, runId: recipient.runId, receivedAtMs: nowMs, text: inspected.link, messageIdHash: inspected.messageIdHash }, nowMs);
    if (result !== 'stored') return await reject(result, recipient.address);
    await log('accepted', { recipient: recipient.address, size: raw.byteLength });
  } catch {
    await reject('error');
  }
}

async function handleClaim(request: Request, env: Env): Promise<Response> {
  const cfg = loadConfig(env);
  if (!cfg) return UNAVAILABLE();
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY) return json(413, { error: 'too_large' });
  const body = await request.text();
  if (body.length > MAX_REQUEST_BODY) return json(413, { error: 'too_large' });

  const ts = request.headers.get(HEADER_TS) ?? '';
  const nonce = request.headers.get(HEADER_NONCE) ?? '';
  const sig = request.headers.get(HEADER_SIG) ?? '';
  const nowMs = Date.now();
  if (!/^\d{10,16}$/.test(ts) || !NONCE.test(nonce) || Math.abs(nowMs - Number(ts)) > REQUEST_FRESHNESS_MS) return UNAUTHORIZED();
  if (!(await verifyRequest(cfg.retrievalKey, { method: 'POST', path: CLAIM_PATH, ts, nonce, body }, sig))) return UNAUTHORIZED();

  // The caller is authenticated from here on; the remaining refusals can say what was wrong.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(400, { error: 'bad_request' });
  }
  const p = parsed as { runId?: unknown; recipient?: unknown };
  if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).sort().join() !== 'recipient,runId' || typeof p.runId !== 'string' || !RUN_ID.test(p.runId)) {
    return json(400, { error: 'bad_request' });
  }
  const recipient = parseRecipient(p.recipient, cfg.recipientDomain);
  if (!recipient || recipient.runId !== p.runId) return json(403, { error: 'forbidden' });

  const result = await env.MAILBOX.get(env.MAILBOX.idFromName(recipient.address)).claim(recipient.runId, nonce, nowMs);
  if (result.kind === 'replay') return UNAUTHORIZED();
  if (result.kind === 'rate_limited') return json(429, { error: 'rate_limited' }, { 'retry-after': '30' });
  const messages: DeliveredMessage[] = [];
  for (const m of result.messages) messages.push({ ...m, mac: await signMessage(cfg.deliveryKey, m) });
  await log(messages.length > 0 ? 'claimed' : 'claim_empty', { recipient: recipient.address });
  return json(200, { messages });
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return loadConfig(env) ? json(200, { ok: true }) : UNAVAILABLE();
    if (url.pathname === CLAIM_PATH) return request.method === 'POST' ? handleClaim(request, env) : json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    return json(404, { error: 'not_found' });
  },
} satisfies ExportedHandler<Env>;
