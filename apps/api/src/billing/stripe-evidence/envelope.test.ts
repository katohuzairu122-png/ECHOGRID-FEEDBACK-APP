import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalAad,
  createWrappedDek,
  EVIDENCE_SCHEMA_VERSION,
  EvidenceCryptoError,
  openPayload,
  rewrapDek,
  sealPayload,
  sha256,
  unwrapDek,
  type EnvelopeBinding,
  type SealedEnvelope,
} from './envelope';

const enc = new TextEncoder();
const BODY = enc.encode('synthetic-private-envelope-marker');
const MAX_BYTES = 16_777_216; // Existing migration 0045 payload_bytes bound.
const binding: EnvelopeBinding = {
  table: 'stripe_provider_events',
  identity: 'acct_fixtureReceiver|acct_fixtureEvent|false|evt_fixture|webhook_signature',
  cohort: '2099-01',
  kekVersion: 'synthetic-v1',
};
const key = (bits = 256) =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: bits }, false, [
    'encrypt',
    'decrypt',
  ]) as Promise<CryptoKey>;
const flip = (bytes: Uint8Array, at = 0) => {
  const copy = bytes.slice();
  copy[at] = (copy[at] ?? 0) ^ 1;
  return copy;
};
const aad = (b = binding, digest: Uint8Array, version = EVIDENCE_SCHEMA_VERSION) =>
  canonicalAad([b.table, b.identity, digest, b.cohort, b.kekVersion, version]);

// Direct WebCrypto fixtures exercise authentication independently of sealPayload.
async function forge(
  dek: CryptoKey,
  body = BODY,
  digest?: Uint8Array,
  nonce = new Uint8Array(12),
  version = EVIDENCE_SCHEMA_VERSION,
) {
  const hash = digest ?? (await sha256(body));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce as BufferSource,
        additionalData: aad(binding, hash, version) as BufferSource,
        tagLength: 128,
      },
      dek,
      body as BufferSource,
    ),
  );
  return { ciphertext, nonce, payloadSha256: hash };
}
async function failure(run: Promise<unknown>, code: string) {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EvidenceCryptoError);
  expect(error).toMatchObject({ code, message: `Evidence crypto failure: ${code}` });
  expect(error).not.toHaveProperty('cause');
  return error;
}
afterEach(() => vi.restoreAllMocks());

describe('standalone candidate envelope integrity — no capture or provider authority', () => {
  let dek: CryptoKey;
  let sealed: SealedEnvelope;
  beforeEach(async () => {
    dek = await key();
    sealed = await sealPayload(dek, BODY, binding);
  });

  it('round-trips exact bytes with schema-compatible lengths and a non-extractable AES-256 key', async () => {
    expect(await openPayload(dek, sealed, binding)).toEqual(BODY);
    expect(dek.extractable).toBe(false);
    expect(dek.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(sealed.nonce.byteLength).toBe(12);
    expect(sealed.payloadSha256.byteLength).toBe(32);
    expect(sealed.payloadBytes).toBe(BODY.byteLength);
    expect(sealed.ciphertext.byteLength).toBe(BODY.byteLength + 16);
  });
  it.each(['ciphertext', 'tag', 'nonce', 'digest'])(
    'rejects tampered %s without returning plaintext',
    async (field) => {
      const row = { ...sealed };
      if (field === 'ciphertext') row.ciphertext = flip(sealed.ciphertext);
      if (field === 'tag') row.ciphertext = flip(sealed.ciphertext, sealed.ciphertext.length - 1);
      if (field === 'nonce') row.nonce = flip(sealed.nonce);
      if (field === 'digest') row.payloadSha256 = flip(sealed.payloadSha256);
      await failure(openPayload(dek, row, binding), 'DECRYPT_FAILED');
    },
  );
  it('rejects a different AES-256 decryption key', async () => {
    await failure(openPayload(await key(), sealed, binding), 'DECRYPT_FAILED');
  });
  it.each([
    ['table', { table: 'stripe_provider_malformed_receipts' }],
    [
      'receiving account',
      { identity: binding.identity.replace('acct_fixtureReceiver', 'acct_otherReceiver') },
    ],
    [
      'event account',
      { identity: binding.identity.replace('acct_fixtureEvent', 'acct_otherEvent') },
    ],
    ['mode', { identity: binding.identity.replace('|false|', '|true|') }],
    ['event ID', { identity: binding.identity.replace('evt_fixture', 'evt_other') }],
    ['provenance', { identity: binding.identity.replace('webhook_signature', 'api_retrieval') }],
    ['cohort', { cohort: '2099-02' }],
    ['key version', { kekVersion: 'synthetic-v2' }],
  ] as const)('authenticates changed %s bytes in AAD', async (_field, change) => {
    await failure(openPayload(dek, sealed, { ...binding, ...change }), 'DECRYPT_FAILED');
  });
  it('rejects a direct WebCrypto fixture carrying another encryption version in AAD', async () => {
    await failure(
      openPayload(
        dek,
        await forge(dek, BODY, undefined, new Uint8Array(12), 'synthetic-wrong-version'),
        binding,
      ),
      'DECRYPT_FAILED',
    );
  });
  it('recomputes plaintext digest even when the GCM tag authenticates a wrong digest', async () => {
    await failure(
      openPayload(dek, await forge(dek, BODY, new Uint8Array(32)), binding),
      'DIGEST_MISMATCH',
    );
  });
  it('does not accept ciphertext transplanted between distinct evidence identities', async () => {
    const other = { ...binding, identity: 'synthetic-other-record' };
    const second = await sealPayload(dek, enc.encode('synthetic-second-private-marker'), other);
    await failure(openPayload(dek, second, binding), 'DECRYPT_FAILED');
  });
  it('demonstrates that identical caller-supplied binding is not independent row-ID authority', async () => {
    // Blocked semantic finding: no record-ID field exists in this interface. Do not invent one.
    const second = await sealPayload(dek, enc.encode('another synthetic record'), binding);
    expect(await openPayload(dek, second, binding)).toEqual(enc.encode('another synthetic record'));
  });
  it('generates fresh nonces for repeated identical plaintext', async () => {
    const samples = await Promise.all(
      Array.from({ length: 8 }, () => sealPayload(dek, BODY, binding)),
    );
    expect(new Set(samples.map((s) => Array.from(s.nonce).join(','))).size).toBe(8);
    expect(new Set(samples.map((s) => Array.from(s.ciphertext).join(','))).size).toBe(8);
  });
  it('uses existing length-prefixed UTF-8 AAD bytes without changing serialization', () => {
    expect(EVIDENCE_SCHEMA_VERSION).toBe('heta01-f1/1');
    expect(canonicalAad(['ab', 'c'])).toEqual(new Uint8Array([0, 0, 0, 2, 97, 98, 0, 0, 0, 1, 99]));
    expect(canonicalAad(['é'])).toEqual(new Uint8Array([0, 0, 0, 2, 195, 169]));
    expect(canonicalAad(['ab', 'c'])).not.toEqual(canonicalAad(['a', 'bc']));
  });
  it.each([0, 8, 11, 13, 16])(
    'rejects nonce length %s with a stable validation error',
    async (length) => {
      await failure(
        openPayload(dek, { ...sealed, nonce: new Uint8Array(length) }, binding),
        'BAD_INPUT',
      );
    },
  );
  it('rejects a validly authenticated 16-byte nonce that WebCrypto itself permits', async () => {
    await failure(
      openPayload(dek, await forge(dek, BODY, undefined, new Uint8Array(16)), binding),
      'BAD_INPUT',
    );
  });
  it.each([0, 1, 15, 16])('rejects structurally truncated ciphertext length %s', async (length) => {
    await failure(
      openPayload(dek, { ...sealed, ciphertext: sealed.ciphertext.slice(0, length) }, binding),
      'BAD_INPUT',
    );
  });
  it('rejects authenticated ciphertext truncated after its minimum structural length', async () => {
    await failure(
      openPayload(dek, { ...sealed, ciphertext: sealed.ciphertext.slice(0, -1) }, binding),
      'DECRYPT_FAILED',
    );
  });
  it('rejects oversized ciphertext before decrypting', async () => {
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    await failure(
      openPayload(dek, { ...sealed, ciphertext: new Uint8Array(MAX_BYTES + 17) }, binding),
      'BAD_INPUT',
    );
    expect(decrypt).not.toHaveBeenCalled();
  });
  it('rejects plaintext larger than the existing 0045 bound', async () => {
    await failure(sealPayload(dek, new Uint8Array(MAX_BYTES + 1), binding), 'BAD_INPUT');
  });
  it('rejects empty or malformed plaintext with stable errors', async () => {
    await failure(sealPayload(dek, new Uint8Array(0), binding), 'BAD_INPUT');
    await failure(sealPayload(dek, null as unknown as Uint8Array, binding), 'BAD_INPUT');
  });
  it('redacts standalone digest-provider errors', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('synthetic-secret-marker'));
    await failure(sha256(BODY), 'BAD_INPUT');
  });
  it('accepts the exact existing payload-size bound', async () => {
    const payload = new Uint8Array(MAX_BYTES).fill(17);
    const row = await sealPayload(dek, payload, binding);
    const reopened = await openPayload(dek, row, binding);
    expect(reopened.byteLength).toBe(payload.byteLength);
    expect(await sha256(reopened)).toEqual(await sha256(payload));
  });
  it.each([0, 31, 33])('rejects malformed digest length %s', async (length) => {
    await failure(
      openPayload(dek, { ...sealed, payloadSha256: new Uint8Array(length) }, binding),
      'BAD_INPUT',
    );
  });
  it.each(['table', 'identity', 'cohort', 'kekVersion'] as const)(
    'rejects missing/empty %s metadata',
    async (field) => {
      await failure(sealPayload(dek, BODY, { ...binding, [field]: '' }), 'BAD_INPUT');
      await failure(
        openPayload(dek, sealed, { ...binding, [field]: undefined } as unknown as EnvelopeBinding),
        'BAD_INPUT',
      );
    },
  );
  it('rejects malformed envelope objects using stable errors', async () => {
    await failure(openPayload(dek, null as unknown as SealedEnvelope, binding), 'BAD_INPUT');
    await failure(
      openPayload(
        dek,
        { ...sealed, ciphertext: 'not-bytes' } as unknown as SealedEnvelope,
        binding,
      ),
      'BAD_INPUT',
    );
  });
  it('rejects AES-128 keys for an AES-256 envelope', async () => {
    const short = await key(128);
    await failure(sealPayload(short, BODY, binding), 'BAD_INPUT');
    await failure(openPayload(short, await forge(short), binding), 'BAD_INPUT');
  });
  it('does not expose provider exceptions or log plaintext on encryption failure', async () => {
    const logs = ['log', 'info', 'warn', 'error'].map((m) => vi.spyOn(console, m as 'log'));
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValue(
      new Error('synthetic-secret ' + new TextDecoder().decode(BODY)),
    );
    const error = await failure(sealPayload(dek, BODY, binding), 'BAD_INPUT');
    expect(String(error)).not.toContain('synthetic-secret');
    expect(String(error)).not.toContain(new TextDecoder().decode(BODY));
    logs.forEach((log) => expect(log).not.toHaveBeenCalled());
  });
  it('redacts post-decryption digest failure and clears the owned plaintext buffer', async () => {
    const buffer = BODY.slice().buffer;
    vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(buffer);
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(
      new Error('synthetic-secret ' + new TextDecoder().decode(BODY)),
    );
    await failure(openPayload(dek, sealed, binding), 'DECRYPT_FAILED');
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array(BODY.length));
  });
  it('never performs network requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    expect(await openPayload(dek, sealed, binding)).toEqual(BODY);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('snapshots caller plaintext and binding before awaiting encryption work', async () => {
    const payload = BODY.slice();
    const metadata = { ...binding };
    const pending = sealPayload(dek, payload, metadata);
    payload.fill(0);
    metadata.identity = 'synthetic-mutated-record';
    expect(await openPayload(dek, await pending, binding)).toEqual(BODY);
  });
  it('does not let a mutable digest bypass the post-decryption consistency check', async () => {
    const incorrect = new Uint8Array(32);
    const row = await forge(dek, BODY, incorrect);
    const original = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      const hash = await original(...args);
      incorrect.set(new Uint8Array(hash));
      return hash;
    });
    await failure(openPayload(dek, row, binding), 'DIGEST_MISMATCH');
  });
});

describe('synthetic DEK wrapping primitives — no operational rotation or custody policy', () => {
  it('wraps and unwraps a non-extractable AES-256 DEK', async () => {
    const kek = await key();
    const { wrapped, dek } = await createWrappedDek(kek, binding.cohort, binding.kekVersion);
    const restored = await unwrapDek(kek, wrapped, binding.cohort, binding.kekVersion);
    expect(restored.extractable).toBe(false);
    expect(wrapped.wrappedDek.length).toBe(48);
    const row = await sealPayload(dek, BODY, binding);
    expect(await openPayload(restored, row, binding)).toEqual(BODY);
  });
  it('rejects wrong KEK, cohort and key version', async () => {
    const kek = await key();
    const { wrapped } = await createWrappedDek(kek, binding.cohort, binding.kekVersion);
    await failure(
      unwrapDek(await key(), wrapped, binding.cohort, binding.kekVersion),
      'UNWRAP_FAILED',
    );
    await failure(unwrapDek(kek, wrapped, '2099-02', binding.kekVersion), 'UNWRAP_FAILED');
    await failure(unwrapDek(kek, wrapped, binding.cohort, 'synthetic-v2'), 'UNWRAP_FAILED');
    await failure(
      unwrapDek(
        kek,
        { ...wrapped, dekFingerprint: flip(wrapped.dekFingerprint) },
        binding.cohort,
        binding.kekVersion,
      ),
      'FINGERPRINT_MISMATCH',
    );
  });
  it('rewraps the same synthetic DEK without modifying the payload envelope', async () => {
    const old = await key();
    const next = await key();
    const { wrapped, dek } = await createWrappedDek(old, binding.cohort, binding.kekVersion);
    const row = await sealPayload(dek, BODY, binding);
    const moved = await rewrapDek(
      old,
      wrapped,
      binding.cohort,
      binding.kekVersion,
      next,
      'synthetic-v2',
    );
    expect(moved.dekFingerprint).toEqual(wrapped.dekFingerprint);
    const restored = await unwrapDek(next, moved, binding.cohort, 'synthetic-v2');
    expect(await openPayload(restored, row, binding)).toEqual(BODY);
  });
  it('rejects a validly encrypted non-256-bit DEK instead of rewrapping it', async () => {
    const kek = await key();
    const raw = new Uint8Array(16).fill(31);
    const nonce = new Uint8Array(12);
    const wrappedDek = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: canonicalAad([
            'dek-wrap',
            binding.cohort,
            binding.kekVersion,
            EVIDENCE_SCHEMA_VERSION,
          ]) as BufferSource,
          tagLength: 128,
        },
        kek,
        raw,
      ),
    );
    const row = {
      wrappedDek,
      wrapNonce: nonce,
      dekFingerprint: await sha256(canonicalAad(['heta01-f1-dek-fingerprint-v1\0', raw])),
    };
    await failure(
      rewrapDek(kek, row, binding.cohort, binding.kekVersion, await key(), 'synthetic-v2'),
      'BAD_INPUT',
    );
  });
  it('rejects a non-AES-256 wrapping key', async () => {
    await failure(
      createWrappedDek(await key(128), binding.cohort, binding.kekVersion),
      'BAD_INPUT',
    );
  });
  it('redacts wrapping-provider errors', async () => {
    const kek = await key();
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValue(new Error('synthetic-key-material'));
    await failure(createWrappedDek(kek, binding.cohort, binding.kekVersion), 'BAD_INPUT');
  });
});
