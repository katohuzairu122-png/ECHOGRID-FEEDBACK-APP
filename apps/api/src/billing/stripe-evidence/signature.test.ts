import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { DEFAULT_TOLERANCE_SECONDS, VERIFIER_VERSION, verifyWebhookSignature } from './signature';

const NOW = new Date('2026-10-20T00:00:00Z');
const TS = NOW.getTime() / 1000;
// Synthetic HMAC inputs only. These are not Stripe credentials.
const CURRENT = 'synthetic-current-signing-material';
const PREVIOUS = 'synthetic-previous-signing-material';
const BODY = '{"fixture":"private-marker-should-never-be-logged"}';
const secrets = [
  { label: 'current', secret: CURRENT },
  { label: 'previous', secret: PREVIOUS },
];
function mac(body = BODY, timestamp = TS, secret = CURRENT) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
function header(body = BODY, timestamp = TS, secret = CURRENT) {
  return `t=${timestamp},v1=${mac(body, timestamp, secret)}`;
}
const verify = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
  verifyWebhookSignature({ rawBody: BODY, header: header(), secrets, now: NOW, ...overrides });

afterEach(() => vi.restoreAllMocks());

describe('standalone HETA signature verification — not wired to capture', () => {
  it('verifies an independent HMAC fixture and returns only non-secret provenance', async () => {
    expect(await verify()).toEqual({
      ok: true,
      provenance: {
        headerTimestamp: TS,
        scheme: 'v1',
        secretLabel: 'current',
        verifiedAt: NOW,
        verifierVersion: VERIFIER_VERSION,
      },
    });
  });
  it('supports the previous signing secret without exposing it', async () => {
    expect(await verify({ header: header(BODY, TS, PREVIOUS) })).toMatchObject({
      ok: true,
      provenance: { secretLabel: 'previous' },
    });
  });
  it('accepts any matching v1 signature during rotation', async () => {
    expect(await verify({ header: `t=${TS},v1=${'0'.repeat(64)},v1=${mac()}` })).toMatchObject({
      ok: true,
    });
  });
  it('verifies authentic non-JSON bytes without parsing or attributing an event', async () => {
    const body = 'synthetic authenticated malformed receipt';
    expect(await verify({ rawBody: body, header: header(body) })).toMatchObject({ ok: true });
  });
  it('rejects a change to the exact raw body', async () => {
    expect(await verify({ rawBody: BODY + '\n' })).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });
  it('rejects a wrong secret', async () => {
    expect(await verify({ secrets: [{ label: 'other', secret: 'synthetic-wrong' }] })).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });
  it.each([-1, 1])('rejects a timestamp beyond the window in direction %s', async (direction) => {
    expect(
      await verify({ header: header(BODY, TS + direction * (DEFAULT_TOLERANCE_SECONDS + 1)) }),
    ).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });
  it.each([-1, 1])(
    'accepts the exact finite tolerance boundary in direction %s',
    async (direction) => {
      expect(
        await verify({ header: header(BODY, TS + direction * DEFAULT_TOLERANCE_SECONDS) }),
      ).toMatchObject({ ok: true });
    },
  );
  it.each([null, undefined, ''])('rejects a missing header: %s', async (value) => {
    expect(await verify({ header: value })).toEqual({ ok: false, reason: 'MISSING_HEADER' });
  });
  it.each([
    ['no timestamp', `v1=${mac()}`],
    ['no v1', `t=${TS},v0=${mac()}`],
    ['bad digest shape', `t=${TS},v1=not-a-digest`],
    ['non-numeric timestamp', `t=not-a-time,v1=${mac()}`],
    ['duplicate timestamp', `t=${TS},t=${TS},v1=${mac()}`],
    ['trailing invalid timestamp', `t=${TS},t=${TS + 3600}junk,v1=${mac(BODY, TS + 3600)}`],
    ['invalid timestamp overwritten by valid timestamp', `t=bad,t=${TS},v1=${mac()}`],
    [
      'SDK timestamp key differs after whitespace',
      `t=${TS + 3600}, t=${TS},v1=${mac(BODY, TS + 3600)}`,
    ],
    ['invalid duplicate signature', `t=${TS},v1=bad,v1=${mac()}`],
  ])('rejects malformed/ambiguous header: %s', async (_name, value) => {
    expect(await verify({ header: value })).toEqual({ ok: false, reason: 'MALFORMED_HEADER' });
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not disable freshness with tolerance %s',
    async (toleranceSeconds) => {
      expect(await verify({ header: header(BODY, TS - 3600), toleranceSeconds })).toEqual({
        ok: false,
        reason: 'INVALID_SIGNATURE',
      });
    },
  );
  it('rejects an invalid verification clock', async () => {
    expect(await verify({ now: new Date(Number.NaN) })).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });
  it('uses an explicit shorter positive window', async () => {
    expect(await verify({ header: header(BODY, TS - 11), toleranceSeconds: 10 })).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });
  it('rejects an empty configured secret even if its HMAC matches', async () => {
    expect(
      await verify({ header: header(BODY, TS, ''), secrets: [{ label: 'empty', secret: '' }] }),
    ).toEqual({ ok: false, reason: 'NO_SECRET' });
  });
  it('rejects missing secret configuration', async () => {
    expect(await verify({ secrets: [] })).toEqual({ ok: false, reason: 'NO_SECRET' });
  });
  it('rejects an empty provenance label', async () => {
    expect(await verify({ secrets: [{ label: '', secret: CURRENT }] })).toEqual({
      ok: false,
      reason: 'NO_SECRET',
    });
  });
  it('does not make network requests', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network forbidden in this fixture'));
    expect(await verify()).toMatchObject({ ok: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('redacts crypto-provider initialization failure', async () => {
    vi.spyOn(Stripe, 'createSubtleCryptoProvider').mockImplementation(() => {
      throw new Error(`${CURRENT} ${BODY}`);
    });
    expect(await verify()).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });
  it('does not return caller-owned mutable clock state', async () => {
    const now = new Date(NOW);
    const result = await verify({ now });
    now.setTime(0);
    expect(result).toMatchObject({ ok: true, provenance: { verifiedAt: NOW } });
  });
  it('redacts cryptographic provider exceptions and never logs raw payload, signature or secret', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const provider = Stripe.createSubtleCryptoProvider();
    vi.spyOn(provider, 'computeHMACSignatureAsync').mockRejectedValue(
      new Error(`${CURRENT} ${BODY} ${header()}`),
    );
    const result = await verify({ cryptoProvider: provider });
    expect(result).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(CURRENT);
    expect(JSON.stringify(result)).not.toContain(BODY);
    expect(JSON.stringify(result)).not.toContain(header());
  });
});
