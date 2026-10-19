import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import {
  canonicalAad, createWrappedDek, unwrapDek, rewrapDek, sealPayload, openPayload, sha256, equalBytes,
  loadKeyring, cohortOf, EvidenceKeyringError, classifyEnvelope, verifyWebhookSignature, VERIFIER_VERSION,
} from './index';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const b64 = (n: number) => Buffer.alloc(32, n).toString('base64');
const entry = (cohort: string, ver: string, n: number, over: Record<string, unknown> = {}) => ({
  cohort, kek_version: ver, alg: 'AES-256-GCM', key: b64(n), not_before: `${cohort}-01T00:00:00Z`, not_after: '2030-01-01T00:00:00Z', active: true, ...over,
});
const ring = (keys: unknown[]) => JSON.stringify({ v: 1, keys });
const goodRing = () => ring([entry('2026-10', 'v1', 1), entry('2026-11', 'v1', 2), entry('2026-12', 'v1', 3)]);
const code = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'ERR');

describe('keyring loader (C.3, fail closed)', () => {
  it('loads a valid keyring, selects the active entry for the capture month, keys are non-extractable', async () => {
    const k = await loadKeyring(goodRing(), NOW);
    expect(cohortOf(NOW)).toBe('2026-10');
    const a = k.activeFor(NOW);
    expect(a.cohort).toBe('2026-10');
    expect(a.key.extractable).toBe(false);
    expect(k.find('2026-11', 'v1')?.kekVersion).toBe('v1');
  });

  it.each([
    ['missing', undefined, 'KEYRING_MISSING'],
    ['not json', '{nope', 'KEYRING_NOT_JSON'],
    ['wrong schema version', JSON.stringify({ v: 2, keys: [] }), 'KEYRING_SCHEMA'],
    ['empty keys', ring([]), 'KEYRING_SCHEMA'],
    ['more than 8 entries', ring(Array.from({ length: 9 }, (_, i) => entry('2026-10', `v${i}`, i + 1))), 'KEYRING_TOO_LARGE'],
    ['short key', ring([entry('2026-10', 'v1', 1, { key: Buffer.alloc(16).toString('base64') })]), 'KEYRING_KEY_LENGTH'],
    ['non-base64 key', ring([entry('2026-10', 'v1', 1, { key: '***' })]), 'KEYRING_KEY_LENGTH'],
    ['bad cohort', ring([entry('2026-13', 'v1', 1)]), 'KEYRING_COHORT_PATTERN'],
    ['duplicate cohort+version', ring([entry('2026-10', 'v1', 1), entry('2026-10', 'v1', 2)]), 'KEYRING_DUPLICATE'],
    ['two active in a cohort', ring([entry('2026-10', 'v1', 1), entry('2026-10', 'v2', 2)]), 'KEYRING_MULTIPLE_ACTIVE'],
    ['window inverted', ring([entry('2026-10', 'v1', 1, { not_after: '2026-09-01T00:00:00Z' })]), 'KEYRING_WINDOW'],
    ['no current active', ring([entry('2026-10', 'v1', 1, { active: false }), entry('2026-11', 'v1', 2)]), 'KEYRING_NO_CURRENT_ACTIVE'],
    ['no runway', ring([entry('2026-10', 'v1', 1)]), 'KEYRING_NO_RUNWAY'],
    ['wrong algorithm', ring([entry('2026-10', 'v1', 1, { alg: 'AES-128-GCM' })]), 'KEYRING_SCHEMA'],
  ])('rejects %s', async (_n, secret, expected) => {
    expect(await code(loadKeyring(secret as string | undefined, NOW))).toBe(expected);
  });

  it('errors carry a code only and never key material', async () => {
    const secret = ring([entry('2026-10', 'v1', 9, { key: Buffer.alloc(16, 9).toString('base64') })]);
    const err = (await loadKeyring(secret, NOW).then(() => null, (e: unknown) => e)) as EvidenceKeyringError;
    expect(err).toBeInstanceOf(EvidenceKeyringError);
    expect(String(err.message)).not.toContain(Buffer.alloc(16, 9).toString('base64'));
  });

  it('refuses a capture time outside the active window', async () => {
    const k = await loadKeyring(goodRing(), NOW);
    expect(() => k.activeFor(new Date('2026-09-30T23:59:59Z'))).toThrow(EvidenceKeyringError);
  });
});

describe('envelope crypto (C.1/C.2)', () => {
  const binding = { table: 'stripe_provider_events', identity: 'acct_A|acct_A|false|evt_1|webhook_signature', cohort: '2026-10', kekVersion: 'v1' };

  async function fixture() {
    const kr = await loadKeyring(goodRing(), NOW);
    const kek = kr.activeFor(NOW).key;
    const { wrapped, dek } = await createWrappedDek(kek, '2026-10', 'v1');
    return { kek, wrapped, dek };
  }

  it('T13: round-trips and the stored digest matches the plaintext', async () => {
    const { dek } = await fixture();
    const body = new TextEncoder().encode('{"id":"evt_1"}');
    const sealed = await sealPayload(dek, body, binding);
    expect(sealed.nonce.length).toBe(12);
    expect(equalBytes(sealed.payloadSha256, await sha256(body))).toBe(true);
    expect(new TextDecoder().decode(await openPayload(dek, sealed, binding))).toBe('{"id":"evt_1"}');
  });

  it('T14: ciphertext cannot be moved to another row, table, cohort or kek_version (AAD binding)', async () => {
    const { dek } = await fixture();
    const sealed = await sealPayload(dek, new TextEncoder().encode('payload'), binding);
    for (const moved of [
      { ...binding, identity: 'acct_A|acct_A|false|evt_2|webhook_signature' },
      { ...binding, table: 'stripe_provider_event_conflicts' },
      { ...binding, cohort: '2026-11' },
      { ...binding, kekVersion: 'v2' },
    ]) {
      expect(await code(openPayload(dek, sealed, moved))).toBe('DECRYPT_FAILED');
    }
  });

  it('T14: tampered ciphertext, nonce or digest return no plaintext', async () => {
    const { dek } = await fixture();
    const sealed = await sealPayload(dek, new TextEncoder().encode('payload'), binding);
    const flip = (u: Uint8Array) => Uint8Array.from(u, (b, i) => (i === 0 ? b ^ 1 : b));
    expect(await code(openPayload(dek, { ...sealed, ciphertext: flip(sealed.ciphertext) }, binding))).toBe('DECRYPT_FAILED');
    expect(await code(openPayload(dek, { ...sealed, nonce: flip(sealed.nonce) }, binding))).toBe('DECRYPT_FAILED');
    expect(await code(openPayload(dek, { ...sealed, payloadSha256: flip(sealed.payloadSha256) }, binding))).toBe('DECRYPT_FAILED');
  });

  it('uses a fresh random nonce per encryption', async () => {
    const { dek } = await fixture();
    const body = new TextEncoder().encode('same');
    const a = await sealPayload(dek, body, binding);
    const b = await sealPayload(dek, body, binding);
    expect(equalBytes(a.nonce, b.nonce)).toBe(false);
    expect(equalBytes(a.ciphertext, b.ciphertext)).toBe(false);
  });

  it('T15: unwrap verifies the fingerprint; wrong KEK, wrong cohort or wrong version fail; the DEK is non-extractable', async () => {
    const { kek, wrapped } = await fixture();
    const dek = await unwrapDek(kek, wrapped, '2026-10', 'v1');
    expect(dek.extractable).toBe(false);
    const other = (await loadKeyring(goodRing(), NOW)).find('2026-11', 'v1')!.key;
    expect(await code(unwrapDek(other, wrapped, '2026-10', 'v1'))).toBe('UNWRAP_FAILED');
    expect(await code(unwrapDek(kek, wrapped, '2026-11', 'v1'))).toBe('UNWRAP_FAILED');
    expect(await code(unwrapDek(kek, wrapped, '2026-10', 'v2'))).toBe('UNWRAP_FAILED');
    const badFp = { ...wrapped, dekFingerprint: new Uint8Array(32) };
    expect(await code(unwrapDek(kek, badFp, '2026-10', 'v1'))).toBe('FINGERPRINT_MISMATCH');
  });

  it('T16: rotation re-wraps the SAME DEK under a new KEK (equal fingerprint, old ciphertext still opens), without touching ciphertext', async () => {
    const kr = await loadKeyring(goodRing(), NOW);
    const oldKek = kr.activeFor(NOW).key;
    const newKek = kr.find('2026-12', 'v1')!.key;
    const { wrapped, dek } = await createWrappedDek(oldKek, '2026-10', 'v1');
    const sealed = await sealPayload(dek, new TextEncoder().encode('evidence'), binding);
    const rewrapped = await rewrapDek(oldKek, wrapped, '2026-10', 'v1', newKek, 'v2');
    expect(equalBytes(rewrapped.dekFingerprint, wrapped.dekFingerprint)).toBe(true);
    expect(equalBytes(rewrapped.wrappedDek, wrapped.wrappedDek)).toBe(false);
    const viaNew = await unwrapDek(newKek, rewrapped, '2026-10', 'v2');
    expect(new TextDecoder().decode(await openPayload(viaNew, sealed, binding))).toBe('evidence');
    // after the old KEK is destroyed the old row alone is unusable, the new row is not
    expect(await code(unwrapDek(newKek, wrapped, '2026-10', 'v1'))).toBe('UNWRAP_FAILED');
  });

  it('canonical AAD is length-prefixed, so field boundaries cannot be forged', () => {
    expect(equalBytes(canonicalAad(['ab', 'c']), canonicalAad(['a', 'bc']))).toBe(false);
  });

  it('rejects an empty payload', async () => {
    const { dek } = await fixture();
    expect(await code(sealPayload(dek, new Uint8Array(0), binding))).toBe('BAD_INPUT');
  });
});

describe('shape classification (A.2b / G.1, T35)', () => {
  const ev = (over: Record<string, unknown> = {}) => JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000, livemode: false, data: { object: { id: 'sub_1' } }, ...over });

  it('accepts a well-formed envelope and extracts advisory fields', () => {
    const r = classifyEnvelope(ev({ api_version: '2026-05-27.dahlia', request: { id: 'req_1', idempotency_key: 'k' } }));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.envelope).toMatchObject({ id: 'evt_1', created: 1700000000, livemode: false, account: null, apiVersion: '2026-05-27.dahlia', requestId: 'req_1', idempotencyKey: 'k' });
    }
  });

  it('classifies non-JSON and non-object bodies with a non-empty defect list', () => {
    const a = classifyEnvelope('not json');
    expect(a).toMatchObject({ kind: 'malformed', parseStatus: 'not_json' });
    const b = classifyEnvelope('[1,2]');
    expect(b).toMatchObject({ kind: 'malformed', parseStatus: 'json_non_object' });
    const c = classifyEnvelope('null');
    expect(c).toMatchObject({ kind: 'malformed', parseStatus: 'json_non_object' });
    for (const r of [a, b, c]) expect(r.kind === 'malformed' && r.defects.length).toBeGreaterThan(0);
  });

  it.each([
    ['missing id', { id: undefined }, 'missing_id'],
    ['bad id', { id: 'sub_1' }, 'bad_id'],
    ['missing created', { created: undefined }, 'missing_created'],
    ['fractional created', { created: 1.5 }, 'bad_created'],
    ['zero created', { created: 0 }, 'bad_created'],
    ['string created', { created: '1700000000' }, 'bad_created'],
    ['missing livemode', { livemode: undefined }, 'missing_livemode'],
    ['string livemode', { livemode: 'false' }, 'bad_livemode'],
    ['missing type', { type: undefined }, 'missing_type'],
    ['empty type', { type: '' }, 'bad_type'],
    ['missing data', { data: undefined }, 'missing_data_object'],
    ['data.object array', { data: { object: [] } }, 'bad_data_object'],
  ])('flags %s', (_n, over, defect) => {
    const r = classifyEnvelope(ev(over));
    expect(r).toMatchObject({ kind: 'malformed', parseStatus: 'json_object_invalid_envelope' });
    expect(r.kind === 'malformed' && r.defects).toContain(defect);
  });
});

describe('verify-first signature path (B.3)', () => {
  const secrets = [{ label: 'primary', secret: 'whsec_test_primary' }, { label: 'previous', secret: 'whsec_test_previous' }];
  const sign = (payload: string, secret: string, timestamp: number) => Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret, timestamp, cryptoProvider: Stripe.createSubtleCryptoProvider() });
  const ts = Math.floor(NOW.getTime() / 1000);

  it('verifies against the exact raw body and records which secret label verified', async () => {
    const body = '{"id":"evt_1"}';
    const r = await verifyWebhookSignature({ rawBody: body, header: await sign(body, 'whsec_test_previous', ts), secrets, now: NOW });
    expect(r).toMatchObject({ ok: true, provenance: { headerTimestamp: ts, scheme: 'v1', secretLabel: 'previous', verifierVersion: VERIFIER_VERSION } });
  });

  it('a validly signed body that is not JSON verifies (it is never an invalid signature) and then classifies as malformed', async () => {
    const body = 'this is not json';
    const r = await verifyWebhookSignature({ rawBody: body, header: await sign(body, 'whsec_test_primary', ts), secrets, now: NOW });
    expect(r.ok).toBe(true);
    expect(classifyEnvelope(body).kind).toBe('malformed');
  });

  it.each([
    ['missing header', undefined, 'MISSING_HEADER'],
    ['malformed header', 'garbage', 'MALFORMED_HEADER'],
  ])('rejects %s', async (_n, header, reason) => {
    expect(await verifyWebhookSignature({ rawBody: '{}', header, secrets, now: NOW })).toEqual({ ok: false, reason });
  });

  it('rejects a body altered after signing, a wrong secret, and a stale timestamp', async () => {
    const body = '{"id":"evt_1"}';
    const header = await sign(body, 'whsec_test_primary', ts);
    expect(await verifyWebhookSignature({ rawBody: body + ' ', header, secrets, now: NOW })).toMatchObject({ ok: false, reason: 'INVALID_SIGNATURE' });
    expect(await verifyWebhookSignature({ rawBody: body, header, secrets: [{ label: 'x', secret: 'whsec_other' }], now: NOW })).toMatchObject({ ok: false, reason: 'INVALID_SIGNATURE' });
    const stale = await sign(body, 'whsec_test_primary', ts - 3600);
    expect(await verifyWebhookSignature({ rawBody: body, header: stale, secrets, now: NOW })).toMatchObject({ ok: false, reason: 'INVALID_SIGNATURE' });
    const future = await sign(body, 'whsec_test_primary', ts + 3600);
    expect(await verifyWebhookSignature({ rawBody: body, header: future, secrets, now: NOW })).toMatchObject({ ok: false, reason: 'INVALID_SIGNATURE' });
    const edge = await sign(body, 'whsec_test_primary', ts - 299);
    expect(await verifyWebhookSignature({ rawBody: body, header: edge, secrets, now: NOW })).toMatchObject({ ok: true });
  });

  it('fails when no secret is configured', async () => {
    const body = '{}';
    expect(await verifyWebhookSignature({ rawBody: body, header: await sign(body, 'whsec_test_primary', ts), secrets: [], now: NOW })).toEqual({ ok: false, reason: 'NO_SECRET' });
  });
});
