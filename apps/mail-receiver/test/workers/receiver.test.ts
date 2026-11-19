import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyMessage, type DeliveredMessage } from '../../src/protocol';
import { DELIVERY_KEY, DOMAIN, PROOF, RETRIEVAL_KEY, SENDER, WEB, link, rawEmail } from '../helpers/email';
import { claim, deliver, get } from '../helpers/worker';

const uid = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const newRun = () => {
  const runId = `r${uid()}`.slice(0, 11);
  return { runId, to: `acc-${runId}-main@${DOMAIN}` };
};
const messagesOf = async (res: Response): Promise<DeliveredMessage[]> => ((await res.json()) as { messages: DeliveredMessage[] }).messages;

describe('inbound mail: what the receiver accepts', () => {
  it('accepts the confirmation email for an exact synthetic recipient and hands it over once, authenticated', async () => {
    const { runId, to } = newRun();
    expect(await deliver(to, rawEmail({ to }))).toEqual({ accepted: true, rejectReason: null });
    const res = await claim(runId, to);
    expect(res.status).toBe(200);
    const [m, ...rest] = await messagesOf(res);
    expect(rest).toHaveLength(0);
    expect(m).toMatchObject({ to, runId, text: link() });
    expect(await verifyMessage(DELIVERY_KEY, m as DeliveredMessage)).toBe(true);
    expect(await verifyMessage(RETRIEVAL_KEY, m as DeliveredMessage)).toBe(false);
    expect((await messagesOf(await claim(runId, to))).length).toBe(0);
  });

  it('keeps only the link: nothing else of the email is returned', async () => {
    const { runId, to } = newRun();
    await deliver(to, rawEmail({ to, html: `<h1>Echo Grid</h1><p>secret-body-text</p><a href="${link()}">x</a>` }));
    const [m] = await messagesOf(await claim(runId, to));
    expect(JSON.stringify(m)).not.toContain('secret-body-text');
    expect(Object.keys(m as object).sort()).toEqual(['mac', 'receivedAtMs', 'runId', 'text', 'to']);
  });

  it.each([
    ['a real person at the approved domain', `alice@${DOMAIN}`],
    ['another domain', 'acc-abcd1234-main@other.example'],
    ['a subdomain of the approved domain', `acc-abcd1234-main@sub.${DOMAIN}`],
    ['a malformed run', `acc-ab-main@${DOMAIN}`],
    ['a plus-tagged address', `acc-abcd1234-main+x@${DOMAIN}`],
  ])('rejects mail for %s', async (_n, to) => {
    const r = await deliver(to, rawEmail({ to }));
    expect(r.accepted).toBe(false);
    expect(r.rejectReason).toBe('Message not accepted');
  });

  it('routes on the envelope recipient, never the To header', async () => {
    const { runId, to } = newRun();
    expect((await deliver(to, rawEmail({ to: `alice@${DOMAIN}` }))).accepted).toBe(true);
    expect((await messagesOf(await claim(runId, to))).length).toBe(1);
    const { to: other } = newRun();
    expect((await deliver(`alice@${DOMAIN}`, rawEmail({ to: other }))).accepted).toBe(false);
  });

  it('rejects mail that fails or lacks Cloudflare DMARC, or comes from an unapproved sender', async () => {
    const { to } = newRun();
    expect((await deliver(to, rawEmail({ to, authResults: 'mx.cloudflare.net; dmarc=fail' }))).accepted).toBe(false);
    expect((await deliver(to, rawEmail({ to, authResults: null }))).accepted).toBe(false);
    expect((await deliver(to, rawEmail({ to, from: 'evil.example' }))).accepted).toBe(false);
  });

  it('rejects an oversized message by declared size and by real size', async () => {
    const { to } = newRun();
    expect((await deliver(to, rawEmail({ to }), {}, 300 * 1024)).accepted).toBe(false);
    const big = rawEmail({ to, text: 'x'.repeat(300 * 1024), html: `<a href="${link()}">x</a>` });
    expect((await deliver(to, big, {}, 100)).accepted).toBe(false);
  });

  it('rejects malformed MIME and a stale or ID-less message', async () => {
    const { to } = newRun();
    expect((await deliver(to, 'garbage')).accepted).toBe(false);
    expect((await deliver(to, rawEmail({ to, date: new Date(Date.now() - 30 * 60_000) }))).accepted).toBe(false);
    expect((await deliver(to, rawEmail({ to, messageId: null }))).accepted).toBe(false);
    expect((await deliver(to, rawEmail({ to, html: '<p>no link</p>' }))).accepted).toBe(false);
  });

  it('rejects a replay of the same email (same Message-ID), also after it was consumed', async () => {
    const { runId, to } = newRun();
    const raw = rawEmail({ to, messageId: '<replay@sender.example>' });
    expect((await deliver(to, raw)).accepted).toBe(true);
    expect((await deliver(to, raw)).accepted).toBe(false);
    await claim(runId, to);
    expect((await deliver(to, raw)).accepted).toBe(false);
  });

  it('stops a flood: at most five unconsumed messages per recipient, and a global ingest limit', async () => {
    const { to } = newRun();
    const results = [];
    for (let i = 0; i < 7; i++) results.push((await deliver(to, rawEmail({ to, messageId: `<m${i}-${uid()}@s.example>` }))).accepted);
    expect(results.filter(Boolean)).toHaveLength(5);
    const limited = await deliver(newRun().to, rawEmail(), { INGEST_LIMIT_PER_10_MIN: '1' });
    const limited2 = await deliver(newRun().to, rawEmail(), { INGEST_LIMIT_PER_10_MIN: '1' });
    expect([limited.accepted, limited2.accepted].filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it('fails closed on an unsafe configuration: no mail, no retrieval, no detail', async () => {
    const { runId, to } = newRun();
    expect((await deliver(to, rawEmail({ to }), { ALLOWED_RECIPIENT_DOMAIN: '' })).accepted).toBe(false);
    expect((await deliver(to, rawEmail({ to }), { RECEIVER_ENVIRONMENT: 'production' })).accepted).toBe(false);
    const res = await claim(runId, to, { over: { ACCEPTANCE_RECEIVER_RETRIEVAL_KEY: 'short' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect((await get('/health', { ALLOWED_RECIPIENT_DOMAIN: '' })).status).toBe(503);
  });

  it('never forwards or replies (the fake message throws if it tries)', async () => {
    const { to } = newRun();
    await expect(deliver(to, rawEmail({ to }))).resolves.toBeDefined();
  });
});

describe('authenticated retrieval', () => {
  it('refuses a request with no credentials, a bad signature, the wrong key, or a delivery-key signature', async () => {
    const { runId, to } = newRun();
    await deliver(to, rawEmail({ to }));
    for (const res of [await claim(runId, to, { sign: false }), await claim(runId, to, { key: 'x'.repeat(40) }), await claim(runId, to, { key: DELIVERY_KEY })]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect((await messagesOf(await claim(runId, to))).length).toBe(1);
  });

  it('refuses a stale or future timestamp', async () => {
    const { runId, to } = newRun();
    expect((await claim(runId, to, { ts: Date.now() - 120_000 })).status).toBe(401);
    expect((await claim(runId, to, { ts: Date.now() + 120_000 })).status).toBe(401);
  });

  it('refuses a replayed request, and says nothing different from any other failed authentication', async () => {
    const { runId, to } = newRun();
    const n = 'ab'.repeat(16);
    const first = await claim(runId, to, { nonce: n });
    expect(first.status).toBe(200);
    const replay = await claim(runId, to, { nonce: n });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'unauthorized' });
  });

  it('a body altered after signing is refused, and nothing is consumed', async () => {
    const { runId, to } = newRun();
    await deliver(to, rawEmail({ to }));
    const res = await claim(runId, to, { sendBody: JSON.stringify({ runId, recipient: to, x: 1 }) });
    expect(res.status).toBe(401);
    expect((await messagesOf(await claim(runId, to))).length).toBe(1);
  });

  it('a signature is bound to its recipient: re-signed for another mailbox it reads only that (empty) mailbox', async () => {
    const { runId, to } = newRun();
    await deliver(to, rawEmail({ to }));
    const res = await claim(runId, `acc-${runId}-other@${DOMAIN}`);
    expect(res.status).toBe(200);
    expect((await messagesOf(res)).length).toBe(0);
    expect((await messagesOf(await claim(runId, to))).length).toBe(1);
  });

  it('a recipient that does not belong to the run, or to an unapproved domain, is forbidden', async () => {
    const { runId, to } = newRun();
    await deliver(to, rawEmail({ to }));
    expect((await claim('zzzz9999', to)).status).toBe(403);
    expect((await claim(runId, `acc-${runId}-main@other.example`)).status).toBe(403);
    expect((await claim(runId, `alice@${DOMAIN}`)).status).toBe(403);
    expect((await claim(runId, `acc-${runId}-main@sub.${DOMAIN}`)).status).toBe(403);
    expect((await messagesOf(await claim(runId, to))).length).toBe(1);
  });

  it('another run cannot read this run\'s mailbox', async () => {
    const a = newRun();
    const b = newRun();
    await deliver(a.to, rawEmail({ to: a.to }));
    expect((await messagesOf(await claim(b.runId, b.to))).length).toBe(0);
    expect((await claim(b.runId, a.to)).status).toBe(403);
  });

  it('strict request shape: extra keys, wrong types, non-JSON, and oversized bodies', async () => {
    const { runId, to } = newRun();
    expect((await claim(runId, to, { body: JSON.stringify({ runId, recipient: to, extra: 1 }) })).status).toBe(400);
    expect((await claim(runId, to, { body: JSON.stringify({ runId: 5, recipient: to }) })).status).toBe(400);
    expect((await claim(runId, to, { body: 'not json' })).status).toBe(400);
    expect((await claim(runId, to, { body: JSON.stringify({ runId, recipient: to, pad: 'x'.repeat(600) }) })).status).toBe(413);
    expect((await claim(runId, to, { body: JSON.stringify([runId, to]) })).status).toBe(400);
  });

  it('exposes no listing, search or other route, and only POST on the claim route', async () => {
    for (const path of ['/', '/v1/messages', '/v1/list', '/v1/search', '/v1/claim/x', '/inbox', '/v1']) expect((await get(path)).status).toBe(404);
    expect((await get('/v1/claim')).status).toBe(405);
    expect((await claim('abcd1234', `acc-abcd1234-main@${DOMAIN}`, { method: 'GET' })).status).toBe(405);
  });

  it('the health route says nothing about the configuration', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('two simultaneous authenticated retrievals over HTTP produce exactly one winner', async () => {
    const { runId, to } = newRun();
    await deliver(to, rawEmail({ to }));
    const results = await Promise.all(Array.from({ length: 12 }, () => claim(runId, to)));
    const counts = await Promise.all(results.map(async (r) => (r.status === 200 ? (await messagesOf(r)).length : -1)));
    expect(counts.filter((n) => n === 1)).toHaveLength(1);
  });
});

describe('logging is redacted', () => {
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('never records a link, proof, key, address, host or body', async () => {
    const { runId, to } = newRun();
    await deliver(to, rawEmail({ to, html: `<p>BODYTEXT-123</p><a href="${link()}">x</a>` }));
    await deliver(`alice@${DOMAIN}`, rawEmail());
    await deliver(to, 'garbage');
    await claim(runId, to);
    await claim(runId, to, { sign: false });
    const all = lines.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [PROOF, WEB, SENDER, DELIVERY_KEY, RETRIEVAL_KEY, 'BODYTEXT-123', to, runId, 'alice', DOMAIN, 'loyalty/signup']) expect(all).not.toContain(secret);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});
