import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HarnessRefusal, parseTargetsConfig, type FetchFn, type MailboxConfig } from '../guard';
import { RestrictedVerificationMailbox } from '../verification-mailbox';
import { MAILBOX_ADAPTERS } from './index';
import { createReceiverSource } from './cloudflare-receiver';
import { CLAIM_PATH, HEADER_NONCE, HEADER_SIG, HEADER_TS, RECEIVER_HOST_ENV, RETRIEVAL_KEY_ENV, canonicalRequest, signRequest } from './receiver-protocol';
import { DELIVERY_KEY_ENV, signMessage } from './spool-envelope';

const DELIVERY = 'test-delivery-key-0123456789abcdef-0123456789';
const RETRIEVAL = 'test-retrieval-key-fedcba9876543210-9876543210';
const HOST = 'receiver.acc-test.example';
const DOMAIN = 'acc-test.example';
const WEB = 'echo-grid-feedback-web-staging.katohuzairu122.workers.dev';
const RUN = 'abcd1234';
const TO = `acc-${RUN}-main@${DOMAIN}`;
const LINK = `https://${WEB}/loyalty/signup/verify#c=11111111-2222-3333-4444-555555555555.${'a'.repeat(64)}`;
const env = { [RECEIVER_HOST_ENV]: HOST, [RETRIEVAL_KEY_ENV]: RETRIEVAL, [DELIVERY_KEY_ENV]: DELIVERY };
const cfg: MailboxConfig = { approved: true, approvedBy: 'owner', adapter: 'cloudflare-receiver', allowedRecipientDomains: [DOMAIN], receiverHost: HOST };

/** A faithful stand-in for the receiver's claim endpoint: verifies the signature like the Worker does and answers once. */
function fakeReceiver(opts: { messages?: Array<{ to: string; runId: string; receivedAtMs: number; text: string }>; status?: number; body?: string; mutate?: (m: Record<string, unknown>) => Record<string, unknown> } = {}) {
  const calls: Array<{ url: string; init: RequestInit; body: string }> = [];
  const used = new Set<string>();
  let queue = [...(opts.messages ?? [])];
  const fetch: FetchFn = async (url, init) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? '');
    calls.push({ url, init: init ?? {}, body });
    const expected = createHmac('sha256', RETRIEVAL).update(canonicalRequest({ method: 'POST', path: CLAIM_PATH, ts: headers.get(HEADER_TS) ?? '', nonce: headers.get(HEADER_NONCE) ?? '', body })).digest('hex');
    if (headers.get(HEADER_SIG) !== expected || used.has(headers.get(HEADER_NONCE) ?? '')) return new Response('{"error":"unauthorized"}', { status: 401 });
    used.add(headers.get(HEADER_NONCE) ?? '');
    if (opts.status && opts.status !== 200) return new Response(opts.body ?? '{}', { status: opts.status });
    if (opts.body !== undefined) return new Response(opts.body, { status: 200 });
    const out = queue.map((m) => { const base = { ...m, mac: signMessage(DELIVERY, m) }; return opts.mutate ? opts.mutate(base) : base; });
    queue = [];
    return new Response(JSON.stringify({ messages: out }), { status: 200 });
  };
  return { fetch, calls };
}

const wrapper = (fetch: FetchFn, now = Date.now()) =>
  new RestrictedVerificationMailbox({ runId: RUN, config: cfg, webHost: WEB, source: createReceiverSource(env, cfg, { fetch, now: () => now }), attempts: 1, sleep: async () => {}, now: () => now, maxAgeMs: 30 * 60_000 });

describe('cloudflare-receiver adapter: configuration fails closed', () => {
  it('is registered under the name the configuration must use', () => {
    expect(MAILBOX_ADAPTERS['cloudflare-receiver']).toBeTypeOf('function');
  });
  it.each([
    ['no receiver host', { ...env, [RECEIVER_HOST_ENV]: undefined }, cfg, RECEIVER_HOST_ENV],
    ['no retrieval key', { ...env, [RETRIEVAL_KEY_ENV]: undefined }, cfg, RETRIEVAL_KEY_ENV],
    ['no delivery key', { ...env, [DELIVERY_KEY_ENV]: undefined }, cfg, DELIVERY_KEY_ENV],
  ])('refuses %s, naming only the variable', (_n, e, c, name) => {
    expect(() => createReceiverSource(e, c)).toThrow(name);
  });
  it('refuses a short retrieval key, and the same key for both jobs', () => {
    expect(() => createReceiverSource({ ...env, [RETRIEVAL_KEY_ENV]: 'short' }, cfg)).toThrow(/at least 32/);
    expect(() => createReceiverSource({ ...env, [RETRIEVAL_KEY_ENV]: DELIVERY }, cfg)).toThrow(/different/);
  });
  it('refuses when the committed configuration has no approved receiver host, or a different one', () => {
    expect(() => createReceiverSource(env, { ...cfg, receiverHost: null })).toThrow(/not approved/);
    expect(() => createReceiverSource(env, undefined)).toThrow(/not approved/);
    expect(() => createReceiverSource({ ...env, [RECEIVER_HOST_ENV]: 'other.acc-test.example' }, cfg)).toThrow(/does not match/);
  });
  it.each(['echo-grid.uk', 'api.echo-grid.uk', 'echo-grid-feedback-api.katohuzairu122.workers.dev', 'prod.example.test', 'Receiver.Example', 'localhost', 'a b.example', 'https://x.example'])(
    'refuses the unacceptable receiver host %j',
    (h) => {
      expect(() => createReceiverSource({ ...env, [RECEIVER_HOST_ENV]: h }, { ...cfg, receiverHost: h })).toThrow();
    },
  );
  it('never puts a key in an error', () => {
    for (const e of [{ ...env, [RETRIEVAL_KEY_ENV]: 'short' }, { ...env, [RETRIEVAL_KEY_ENV]: DELIVERY }]) {
      try { createReceiverSource(e, cfg); } catch (error) { expect(String((error as Error).message)).not.toContain(DELIVERY); expect(String((error as Error).message)).not.toContain('short'.repeat(2)); }
    }
  });
  it('makes no request when constructed', () => {
    const r = fakeReceiver();
    createReceiverSource(env, cfg, { fetch: r.fetch });
    expect(r.calls).toHaveLength(0);
  });
});

describe('cloudflare-receiver adapter: retrieval through the restricted wrapper', () => {
  const now = Date.now();
  const msg = (over: Record<string, unknown> = {}) => ({ to: TO, runId: RUN, receivedAtMs: now - 1000, text: LINK, ...over });

  it('returns the confirmation link and records evidence with no link, proof or address', async () => {
    const r = fakeReceiver({ messages: [msg()] });
    const mailbox = wrapper(r.fetch, now);
    const got = await mailbox.fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 });
    expect(got).toEqual({ kind: 'link', url: LINK });
    const evidence = JSON.stringify(mailbox.evidence());
    for (const secret of ['a'.repeat(64), '11111111-2222', TO, 'abcd1234', HOST, RETRIEVAL, DELIVERY, 'loyalty']) expect(evidence).not.toContain(secret);
    expect(mailbox.evidence()[0]).toMatchObject({ kind: 'link', adapter: 'cloudflare-receiver', cleanup: 'done' });
  });

  it('asks ONE exact recipient of ONE host, signed, and sends no secret in the body or URL', async () => {
    const r = fakeReceiver({ messages: [msg()] });
    await wrapper(r.fetch, now).fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.url).toBe(`https://${HOST}${CLAIM_PATH}`);
    expect(JSON.parse(call.body)).toEqual({ recipient: TO, runId: RUN });
    expect(call.init.redirect).toBe('error');
    expect(call.url + call.body).not.toContain(RETRIEVAL);
    const headers = call.init.headers as Record<string, string>;
    expect(headers[HEADER_SIG]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers[HEADER_NONCE]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('every request has a fresh nonce', async () => {
    const r = fakeReceiver();
    const source = createReceiverSource(env, cfg, { fetch: r.fetch });
    await source.listMessages({ recipient: TO, sinceMs: 0 });
    await source.listMessages({ recipient: TO, sinceMs: 0 });
    const nonces = r.calls.map((c) => (c.init.headers as Record<string, string>)[HEADER_NONCE]);
    expect(new Set(nonces).size).toBe(2);
  });

  it('the request signature equals the known-answer vector the receiver tests assert', () => {
    expect(signRequest(RETRIEVAL, { method: 'POST', path: CLAIM_PATH, ts: '1700000000000', nonce: '0123456789abcdef0123456789abcdef', body: '{"recipient":"acc-abcd1234-main@acc-test.example","runId":"abcd1234"}' })).toBe('7fa4df7f7c3384b9a311c76ca90e42368dadc0ecd7152d24521bb19d51e1bed7');
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });

  it('the one-time claim: a second retrieval finds nothing', async () => {
    const r = fakeReceiver({ messages: [msg()] });
    const mailbox = wrapper(r.fetch, now);
    await mailbox.fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 });
    await expect(mailbox.fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 })).rejects.toThrow(/No verification arrived/);
  });

  it('refuses a message that fails the delivery-key authentication (forged, or from another environment)', async () => {
    for (const mutate of [(m: Record<string, unknown>) => ({ ...m, text: `${LINK}x` }), (m: Record<string, unknown>) => ({ ...m, mac: '0'.repeat(64) }), (m: Record<string, unknown>) => ({ ...m, runId: 'zzzz9999' }), (m: Record<string, unknown>) => ({ ...m, receivedAtMs: now })]) {
      await expect(wrapper(fakeReceiver({ messages: [msg()], mutate }).fetch, now).fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 })).rejects.toThrow(/authentication/);
    }
  });

  it('a validly signed message bound to another run is refused by the wrapper', async () => {
    const other = msg({ runId: 'zzzz9999' });
    await expect(wrapper(fakeReceiver({ messages: [other] }).fetch, now).fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 })).rejects.toThrow(/another run/);
  });

  it('a validly signed message for another recipient is refused', async () => {
    await expect(wrapper(fakeReceiver({ messages: [msg({ to: `acc-${RUN}-other@${DOMAIN}` })] }).fetch, now).fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 })).rejects.toThrow(/another recipient/);
  });

  it('refuses an expired confirmation link and a link on an unapproved host', async () => {
    await expect(wrapper(fakeReceiver({ messages: [msg({ receivedAtMs: now - 16 * 60_000 })] }).fetch, now).fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 17 * 60_000 })).rejects.toThrow(/expired/);
    await expect(wrapper(fakeReceiver({ messages: [msg({ text: LINK.replace(WEB, 'evil.example') })] }).fetch, now).fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 })).rejects.toThrow(/exactly one verification link/);
  });

  it('refuses a recipient outside the approved synthetic namespace before any request', async () => {
    const r = fakeReceiver();
    for (const bad of [`alice@${DOMAIN}`, `acc-${RUN}-main@other.example`, `acc-zzzz9999-main@${DOMAIN}`]) {
      await expect(wrapper(r.fetch, now).fetchVerification({ recipient: bad, purpose: 'customer-signup-link', sinceMs: now - 5000 })).rejects.toThrow(/synthetic recipients/);
    }
    expect(r.calls).toHaveLength(0);
  });

  it('sanitizes every transport failure: fixed sentences, no status body, no host, no key', async () => {
    const cases: Array<[string, FetchFn, RegExp]> = [
      ['network error', async () => { throw new Error(`connect ECONNREFUSED ${HOST} ${RETRIEVAL}`); }, /could not be read/],
      ['401', async () => new Response(`secret ${RETRIEVAL}`, { status: 401 }), /refused the request/],
      ['403', async () => new Response('x', { status: 403 }), /refused the request/],
      ['500', async () => new Response(`stack ${HOST}`, { status: 500 }), /refused the request/],
      ['503', async () => new Response('x', { status: 503 }), /refused the request/],
      ['not json', async () => new Response('<html>', { status: 200 }), /not acceptable/],
      ['wrong shape', async () => new Response('{"messages":"x"}', { status: 200 }), /not acceptable/],
      ['too many', async () => new Response(JSON.stringify({ messages: Array(6).fill({}) }), { status: 200 }), /not acceptable/],
      ['huge', async () => new Response('x'.repeat(200_000), { status: 200 }), /not acceptable/],
    ];
    for (const [, fetch, pattern] of cases) {
      const error = await wrapper(fetch, now).fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(HarnessRefusal);
      expect(String((error as Error).message)).toMatch(pattern);
      for (const leak of [RETRIEVAL, HOST, 'ECONNREFUSED', 'stack', 'secret']) expect((error as Error).message).not.toContain(leak);
    }
  });

  it('rate limiting (429) is "no message yet", not a failure, and the wrapper keeps polling', async () => {
    const r = fakeReceiver({ status: 429 });
    await expect(wrapper(r.fetch, now).fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: now - 5000 })).rejects.toThrow(/No verification arrived/);
  });

  it('a network timeout surfaces as the mailbox timeout, never a hang', async () => {
    const hang: FetchFn = (_u, init) => new Promise((_r, reject) => { (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted'))); });
    const source = createReceiverSource(env, cfg, { fetch: hang });
    const mailbox = new RestrictedVerificationMailbox({ runId: RUN, config: cfg, webHost: WEB, source, attempts: 1, sleep: async () => {}, sourceTimeoutMs: 50 });
    await expect(mailbox.fetchVerification({ recipient: TO, purpose: 'customer-signup-link', sinceMs: Date.now() - 1000 })).rejects.toThrow(/did not answer in time/);
  });
});

describe('cloudflare-receiver configuration in the committed targets file', () => {
  const base = {
    version: 1, approved: false, approvedBy: null, approvedAt: null,
    targets: { api: { host: 'a-api-staging.example.workers.dev' }, web: { host: 'a-web-staging.example.workers.dev' }, cashier: { host: 'a-cashier-staging.example.workers.dev' } },
    customerProvisioning: { approved: false, approvedBy: null }, liveExecution: { authorized: false, authorizedBy: null, reference: null },
  };
  const parse = (mailbox: Record<string, unknown>) => parseTargetsConfig({ ...base, mailbox });
  it('an approved receiver mailbox needs a receiver host and exactly one recipient domain', () => {
    const ok = { approved: true, approvedBy: 'o', adapter: 'cloudflare-receiver', allowedRecipientDomains: [DOMAIN], receiverHost: HOST };
    expect(parse(ok).mailbox.receiverHost).toBe(HOST);
    expect(() => parse({ ...ok, receiverHost: null })).toThrow(/receiverHost/);
    expect(() => parse({ ...ok, allowedRecipientDomains: [DOMAIN, 'b.example'] })).toThrow(/exactly one/);
    expect(() => parse({ ...ok, allowedRecipientDomains: [] })).toThrow();
  });
  it('rejects a receiver host that is production, an application host, malformed or upper-case', () => {
    const mk = (receiverHost: unknown) => parse({ approved: false, approvedBy: null, adapter: 'none', allowedRecipientDomains: [], receiverHost });
    for (const bad of ['api.echo-grid.uk', 'a-web-staging.example.workers.dev', 'Receiver.Example', 'nodots', 5, 'a b.example']) expect(() => mk(bad)).toThrow();
    expect(mk(null).mailbox.receiverHost).toBeNull();
    expect(parse({ approved: false, approvedBy: null, adapter: 'none', allowedRecipientDomains: [] }).mailbox.receiverHost).toBeNull();
  });
});
