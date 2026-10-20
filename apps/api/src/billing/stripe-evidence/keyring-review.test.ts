import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EvidenceKeyringError,
  loadKeyring,
} from '../../../test/fixtures/heta-f1-keyring-candidate';
import {
  createWrappedDek,
  EvidenceCryptoError,
  openPayload,
  rewrapDek,
  sealPayload,
  unwrapDek,
} from './envelope';

// Review-only candidate policy fixtures. They do not define approved cohorts/custody.
const NOW = new Date('2099-01-15T12:00:00Z');
const COHORT = '2099-01';
const VERSION = 'synthetic-v1';
const BODY = new TextEncoder().encode('synthetic-keyring-private-payload');
const MARKER = 'synthetic-provider-private-marker';
const binding = {
  table: 'stripe_provider_events',
  identity: 'synthetic-record-not-provider-authority',
  cohort: COHORT,
  kekVersion: VERSION,
};
function entry(
  cohort: string,
  version: string,
  fill: number,
  changes: Record<string, unknown> = {},
) {
  return {
    cohort,
    kek_version: version,
    alg: 'AES-256-GCM',
    key: Buffer.alloc(32, fill).toString('base64'),
    not_before: `${cohort}-01T00:00:00Z`,
    not_after: '2100-01-01T00:00:00Z',
    active: true,
    ...changes,
  };
}
const ring = (keys: unknown[]) => JSON.stringify({ v: 1, keys });
const good = (fill = 1) =>
  ring([entry(COHORT, VERSION, fill), entry('2099-02', VERSION, fill + 1)]);
async function keyringFailure(run: Promise<unknown>, code: string) {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EvidenceKeyringError);
  expect(error).toMatchObject({ code, message: `Evidence keyring invalid: ${code}` });
  return error;
}
async function cryptoFailure(run: Promise<unknown>, code: string) {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EvidenceCryptoError);
  expect(error).toMatchObject({ code });
}
afterEach(() => vi.restoreAllMocks());

describe('Block D — pinned candidate review, no runtime keyring adoption', () => {
  it('pins the exact upstream Git source, allowing only checkout CRLF normalization', () => {
    const fixture = new URL('../../../test/fixtures/heta-f1-keyring-candidate.ts', import.meta.url);
    const manifest = JSON.parse(
      readFileSync(
        new URL('../../../test/fixtures/heta-f1-keyring-candidate.source.json', import.meta.url),
        'utf8',
      ),
    ) as { commit: string; sha256: string };
    expect(manifest.commit).toBe('86f709d62891a396fa040c14783faae6526e8a5c');
    expect(
      createHash('sha256')
        .update(readFileSync(fixture, 'utf8').replace(/\r\n/g, '\n'))
        .digest('hex'),
    ).toBe(manifest.sha256);
  });
  it('imports a synthetic non-extractable AES-256 KEK and generates/retrieves a compatible DEK', async () => {
    const loaded = await loadKeyring(good(), NOW);
    const kek = loaded.activeFor(NOW).key;
    expect(loaded.find(COHORT, VERSION)?.key).toBe(kek);
    expect(kek.extractable).toBe(false);
    expect(kek.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect([...kek.usages].sort()).toEqual(['decrypt', 'encrypt']);
    await expect(crypto.subtle.exportKey('raw', kek)).rejects.toThrow();
    const { dek, wrapped } = await createWrappedDek(kek, COHORT, VERSION);
    const restored = await unwrapDek(kek, wrapped, COHORT, VERSION);
    expect(restored.extractable).toBe(false);
    const encrypted = await sealPayload(dek, BODY, binding);
    expect(await openPayload(restored, encrypted, binding)).toEqual(BODY);
  });
  it.each([
    ['missing', undefined, 'KEYRING_MISSING'],
    ['empty', '', 'KEYRING_MISSING'],
    ['invalid JSON', '{synthetic-bad', 'KEYRING_NOT_JSON'],
    ['null root', 'null', 'KEYRING_SCHEMA'],
    ['unsupported version', JSON.stringify({ v: 2, keys: [] }), 'KEYRING_SCHEMA'],
    ['no keys', ring([]), 'KEYRING_SCHEMA'],
    ['missing keys', '{"v":1}', 'KEYRING_SCHEMA'],
    ['non-object entry', ring([null]), 'KEYRING_SCHEMA'],
    [
      'short key',
      ring([entry(COHORT, VERSION, 1, { key: Buffer.alloc(16).toString('base64') })]),
      'KEYRING_KEY_LENGTH',
    ],
    [
      'long key',
      ring([entry(COHORT, VERSION, 1, { key: Buffer.alloc(64).toString('base64') })]),
      'KEYRING_KEY_LENGTH',
    ],
    ['invalid base64', ring([entry(COHORT, VERSION, 1, { key: '***' })]), 'KEYRING_KEY_LENGTH'],
    [
      'weaker algorithm',
      ring([entry(COHORT, VERSION, 1, { alg: 'AES-128-GCM' })]),
      'KEYRING_SCHEMA',
    ],
    ['wrong algorithm', ring([entry(COHORT, VERSION, 1, { alg: 'RSA-OAEP' })]), 'KEYRING_SCHEMA'],
    ['missing version', ring([entry(COHORT, '', 1)]), 'KEYRING_SCHEMA'],
    ['bad date', ring([entry(COHORT, VERSION, 1, { not_before: 'bad-date' })]), 'KEYRING_WINDOW'],
    [
      'inverted dates',
      ring([entry(COHORT, VERSION, 1, { not_after: '2000-01-01T00:00:00Z' })]),
      'KEYRING_WINDOW',
    ],
    ['bad cohort', ring([entry('2099-13', VERSION, 1)]), 'KEYRING_COHORT_PATTERN'],
    [
      'no active current key',
      ring([entry(COHORT, VERSION, 1, { active: false })]),
      'KEYRING_NO_CURRENT_ACTIVE',
    ],
    [
      'expired current key',
      ring([entry(COHORT, VERSION, 1, { not_after: '2099-01-02T00:00:00Z' })]),
      'KEYRING_NO_CURRENT_ACTIVE',
    ],
    ['no next-month runway', ring([entry(COHORT, VERSION, 1)]), 'KEYRING_NO_RUNWAY'],
  ])('characterizes candidate rejection: %s', async (_name, serialized, code) => {
    await keyringFailure(loadKeyring(serialized as string | undefined, NOW), code as string);
  });
  it('rejects a duplicate cohort/version tuple', async () => {
    await keyringFailure(
      loadKeyring(ring([entry(COHORT, VERSION, 1), entry(COHORT, VERSION, 2)]), NOW),
      'KEYRING_DUPLICATE',
    );
  });
  it('rejects two active versions in the same cohort', async () => {
    await keyringFailure(
      loadKeyring(ring([entry(COHORT, 'old', 1), entry(COHORT, 'new', 2)]), NOW),
      'KEYRING_MULTIPLE_ACTIVE',
    );
  });
  it('allows the same version label in different cohorts without mixing keys', async () => {
    const loaded = await loadKeyring(good(), NOW);
    const jan = loaded.find(COHORT, VERSION)!.key;
    const feb = loaded.find('2099-02', VERSION)!.key;
    expect(jan).not.toBe(feb);
    const { wrapped } = await createWrappedDek(jan, COHORT, VERSION);
    await cryptoFailure(unwrapDek(feb, wrapped, COHORT, VERSION), 'UNWRAP_FAILED');
  });
  it('returns no fallback for missing cohort/version or permanently unavailable keys', async () => {
    const loaded = await loadKeyring(good(), NOW);
    expect(loaded.find(COHORT, 'missing')).toBeUndefined();
    expect(loaded.find('2099-03', VERSION)).toBeUndefined();
    expect(() => loaded.activeFor(new Date('2099-03-01T00:00:00Z'))).toThrow(EvidenceKeyringError);
    expect(loaded.find(COHORT, 'missing')).toBeUndefined();
  });
  it('keeps concurrent loads independent and usable without a process-wide cache', async () => {
    const loaded = await Promise.all(Array.from({ length: 8 }, () => loadKeyring(good(), NOW)));
    expect(new Set(loaded.map((r) => r.entries)).size).toBe(8);
    expect(new Set(loaded.map((r) => r.activeFor(NOW).key)).size).toBe(8);
    const { wrapped } = await createWrappedDek(loaded[0]!.activeFor(NOW).key, COHORT, VERSION);
    await Promise.all(
      loaded.map(async (r) =>
        expect((await unwrapDek(r.activeFor(NOW).key, wrapped, COHORT, VERSION)).extractable).toBe(
          false,
        ),
      ),
    );
    // This proves independent in-memory imports, not authoritative persisted initialization.
  });
  it('isolates separate loaded configurations even when their labels are identical', async () => {
    const a = await loadKeyring(good(1), NOW);
    const b = await loadKeyring(good(9), NOW);
    const { wrapped } = await createWrappedDek(a.activeFor(NOW).key, COHORT, VERSION);
    await cryptoFailure(unwrapDek(b.activeFor(NOW).key, wrapped, COHORT, VERSION), 'UNWRAP_FAILED');
  });
  it('rejects a wrong KEK, wrong cohort, wrong version, corrupted DEK and wrong fingerprint', async () => {
    const loaded = await loadKeyring(good(), NOW);
    const kek = loaded.activeFor(NOW).key;
    const { wrapped } = await createWrappedDek(kek, COHORT, VERSION);
    await cryptoFailure(
      unwrapDek(loaded.find('2099-02', VERSION)!.key, wrapped, COHORT, VERSION),
      'UNWRAP_FAILED',
    );
    await cryptoFailure(unwrapDek(kek, wrapped, '2099-02', VERSION), 'UNWRAP_FAILED');
    await cryptoFailure(unwrapDek(kek, wrapped, COHORT, 'wrong'), 'UNWRAP_FAILED');
    const ciphertext = wrapped.wrappedDek.slice();
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    await cryptoFailure(
      unwrapDek(kek, { ...wrapped, wrappedDek: ciphertext }, COHORT, VERSION),
      'UNWRAP_FAILED',
    );
    await cryptoFailure(
      unwrapDek(kek, { ...wrapped, dekFingerprint: new Uint8Array(32) }, COHORT, VERSION),
      'FINGERPRINT_MISMATCH',
    );
  });
  it('performs synthetic rewrapping without changing the DEK or payload binding', async () => {
    const loaded = await loadKeyring(
      ring([
        entry(COHORT, 'old', 1, { active: false }),
        entry(COHORT, 'new', 3),
        entry('2099-02', 'new', 4),
      ]),
      NOW,
    );
    const old = loaded.find(COHORT, 'old')!.key;
    const next = loaded.activeFor(NOW).key;
    const oldBinding = { ...binding, kekVersion: 'old' };
    const { dek, wrapped } = await createWrappedDek(old, COHORT, 'old');
    const payload = await sealPayload(dek, BODY, oldBinding);
    const ciphertext = payload.ciphertext.slice();
    const moved = await rewrapDek(old, wrapped, COHORT, 'old', next, 'new');
    expect(moved.dekFingerprint).toEqual(wrapped.dekFingerprint);
    expect(payload.ciphertext).toEqual(ciphertext);
    const restored = await unwrapDek(next, moved, COHORT, 'new');
    expect(await openPayload(restored, payload, oldBinding)).toEqual(BODY);
    await cryptoFailure(
      openPayload(restored, payload, { ...oldBinding, kekVersion: 'new' }),
      'DECRYPT_FAILED',
    );
    // No old-key removal or destruction is performed or certified.
  });
  it('rejects an incorrect old KEK during rewrap', async () => {
    const loaded = await loadKeyring(good(), NOW);
    const old = loaded.activeFor(NOW).key;
    const wrong = loaded.find('2099-02', VERSION)!.key;
    const { wrapped } = await createWrappedDek(old, COHORT, VERSION);
    await cryptoFailure(rewrapDek(wrong, wrapped, COHORT, VERSION, old, 'new'), 'UNWRAP_FAILED');
  });
  it('rejects weaker algorithms and missing operation usages without fallback', async () => {
    const loaded = await loadKeyring(good(), NOW);
    const kek = loaded.activeFor(NOW).key;
    const { wrapped } = await createWrappedDek(kek, COHORT, VERSION);
    const decryptOnly = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(3),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const encryptOnly = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(4),
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const weak = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(16).fill(5),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    await cryptoFailure(createWrappedDek(decryptOnly, COHORT, VERSION), 'BAD_INPUT');
    await cryptoFailure(unwrapDek(encryptOnly, wrapped, COHORT, VERSION), 'UNWRAP_FAILED');
    await cryptoFailure(rewrapDek(kek, wrapped, COHORT, VERSION, decryptOnly, 'new'), 'BAD_INPUT');
    await cryptoFailure(rewrapDek(kek, wrapped, COHORT, VERSION, weak, 'new'), 'BAD_INPUT');
  });
  it('can retry a temporary import failure without a poisoned shared cache', async () => {
    const failure = new Error(MARKER);
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(failure);
    expect(await loadKeyring(good(), NOW).catch((e) => e)).toBe(failure);
    const recovered = await loadKeyring(good(), NOW);
    expect(recovered.activeFor(NOW).key.extractable).toBe(false);
  });
  it('logs no secrets during normal validation and successful load', async () => {
    const logs = ['log', 'info', 'warn', 'error'].map((m) => vi.spyOn(console, m as 'log'));
    await loadKeyring(good(), NOW);
    const bad = ring([entry(COHORT, VERSION, 1, { key: 'synthetic-bad-material' })]);
    const error = await keyringFailure(loadKeyring(bad, NOW), 'KEYRING_KEY_LENGTH');
    expect(String(error)).not.toContain(bad);
    expect(String(error)).not.toContain('synthetic-bad-material');
    logs.forEach((log) => expect(log).not.toHaveBeenCalled());
  });
  it('performs no network requests or database operations', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const loaded = await loadKeyring(good(), NOW);
    await createWrappedDek(loaded.activeFor(NOW).key, COHORT, VERSION);
    expect(fetch).not.toHaveBeenCalled();
    const source = readFileSync(
      new URL('../../../test/fixtures/heta-f1-keyring-candidate.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(
      /\b(?:fetch|DATABASE_URL|historicalTierVerified|issuanceAuthorized|redemptionAuthorized)\b/,
    );
    // Keep this unapproved candidate outside non-test application imports.
    const walk = (directory: string): void => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) walk(path);
        else if (item.name.endsWith('.ts') && !item.name.endsWith('.test.ts')) {
          expect(readFileSync(path, 'utf8'), path).not.toContain('heta-f1-keyring-candidate');
        }
      }
    };
    walk(fileURLToPath(new URL('../../', import.meta.url)));
  });
  it('CHARACTERIZATION: exposed entry objects can mutate subsequent key selection', async () => {
    const loaded = await loadKeyring(good(), NOW);
    loaded.entries[0]!.active = false;
    expect(() => loaded.activeFor(NOW)).toThrow(EvidenceKeyringError);
  });

  describe('BLOCKED candidate controls — expected failures, not remediated security passes', () => {
    it.fails(
      'D-X1: redacts an import-provider exception containing synthetic secret markers',
      async () => {
        vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new Error(MARKER));
        const error = await loadKeyring(good(), NOW).catch((e) => e);
        expect(error).toBeInstanceOf(EvidenceKeyringError);
        expect(String(error)).not.toContain(MARKER);
      },
    );
    it.fails('D-X2: clears decoded raw key bytes if provider import throws', async () => {
      let captured: Uint8Array | undefined;
      vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (_format, data) => {
        captured = data as Uint8Array;
        throw new Error(MARKER);
      });
      await loadKeyring(good(), NOW).catch(() => undefined);
      expect(captured).toBeDefined();
      expect(Array.from(captured!).every((n) => n === 0)).toBe(true);
    });
    it.fails(
      'D-X3: measures its declared byte limit in UTF-8 bytes rather than characters',
      async () => {
        const value = JSON.stringify({
          v: 1,
          keys: [entry(COHORT, VERSION, 1), entry('2099-02', VERSION, 2)],
          note: 'é'.repeat(100),
        });
        expect(new TextEncoder().encode(value).length).toBeGreaterThan(value.length);
        await keyringFailure(loadKeyring(value, NOW, value.length), 'KEYRING_TOO_LARGE');
      },
    );
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
      it.fails(`D-X4: cannot disable the input bound with ${String(limit)}`, async () => {
        await expect(loadKeyring(good(), NOW, limit)).rejects.toBeInstanceOf(EvidenceKeyringError);
      });
    }
    it.fails('D-X5: snapshots the supplied clock before asynchronous imports', async () => {
      const now = new Date(NOW);
      const original = crypto.subtle.importKey.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (...args) => {
        now.setUTCMonth(1);
        return original(...args);
      });
      const loaded = await loadKeyring(good(), now);
      expect(loaded.activeFor(NOW).cohort).toBe(COHORT);
    });
  });
});
