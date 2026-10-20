import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EvidenceKeyringError,
  loadKeyring,
} from '../../../test/fixtures/heta-f1-keyring-remediated';
import { createWrappedDek, openPayload, rewrapDek, sealPayload, unwrapDek } from './envelope';

const NOW = new Date('2099-01-15T12:00:00Z');
const rawKey = Buffer.alloc(32, 23).toString('base64');
const config = (note = '') =>
  JSON.stringify({
    v: 1,
    keys: ['2099-01', '2099-02'].map((cohort) => ({
      cohort,
      kek_version: 'synthetic-v1',
      alg: 'AES-256-GCM',
      key: rawKey,
      not_before: `${cohort}-01T00:00:00Z`,
      not_after: '2100-01-01T00:00:00Z',
      active: true,
    })),
    note,
  });
afterEach(() => vi.restoreAllMocks());

describe('Block E corrected copy — ordinary policy-independent regression tests', () => {
  it('pins corrected source independently while preserving original candidate provenance', () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../../../test/fixtures/heta-f1-keyring-remediated.source.json', import.meta.url),
        'utf8',
      ),
    ) as { sourceIdentifier: string; sha256: string; originalSha256: string };
    const source = readFileSync(
      new URL('../../../test/fixtures/heta-f1-keyring-remediated.ts', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(manifest.sourceIdentifier).toBe('heta-f1-keyring-test-remediation/E1-E6-v1');
    expect(manifest.originalSha256).toBe(
      '145620753b3f10c57fbaacfb805f7f54fd695862c7d1c3b5d5c9de8468c5a8c3',
    );
    expect(createHash('sha256').update(source).digest('hex')).toBe(manifest.sha256);
    expect(manifest.sha256).not.toBe(manifest.originalSha256);
  });
  it('E1: never logs or returns provider secret text, cause or original exception', async () => {
    const marker = `synthetic-private-error ${rawKey}`;
    const original = new Error(marker);
    const spies = ['log', 'info', 'warn', 'error'].map((m) => vi.spyOn(console, m as 'log'));
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(original);
    const error = await loadKeyring(config(), NOW).catch((e) => e);
    expect(error).toBeInstanceOf(EvidenceKeyringError);
    expect(error).toMatchObject({ code: 'KEYRING_IMPORT_FAILED' });
    expect(error).not.toBe(original);
    expect(error).not.toHaveProperty('cause');
    for (const output of [String(error), String(error.stack), JSON.stringify(error)]) {
      expect(output).not.toContain(marker);
      expect(output).not.toContain(rawKey);
    }
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });
  it('E2: clears the exact owned decoded buffers after successful imports', async () => {
    const buffers: Uint8Array[] = [];
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (...args) => {
      buffers.push(args[1] as Uint8Array);
      return original(...args);
    });
    const loaded = await loadKeyring(config(), NOW);
    expect(buffers).toHaveLength(2);
    buffers.forEach((bytes) => expect(Array.from(bytes).every((n) => n === 0)).toBe(true));
    const kek = loaded.activeFor(NOW).key;
    const { wrapped } = await createWrappedDek(kek, '2099-01', 'synthetic-v1');
    expect((await unwrapDek(kek, wrapped, '2099-01', 'synthetic-v1')).extractable).toBe(false);
  });
  it.each(['ASCII', 'é', '漢字', '😀'])('E3: enforces exact UTF-8 bounds for %s', async (note) => {
    const serialized = config(note.repeat(8));
    const length = new TextEncoder().encode(serialized).byteLength;
    expect((await loadKeyring(serialized, NOW, length)).activeFor(NOW).cohort).toBe('2099-01');
    await expect(loadKeyring(serialized, NOW, length - 1)).rejects.toMatchObject({
      code: 'KEYRING_TOO_LARGE',
    });
  });
  it('E3: matches TextEncoder replacement-byte lengths for unpaired surrogates', async () => {
    for (const value of ['\ud800', '\udc00']) {
      const serialized = config('placeholder').replace('"note":"placeholder"', `"note":"${value}"`);
      const length = new TextEncoder().encode(serialized).byteLength;
      expect((await loadKeyring(serialized, NOW, length)).entries).toHaveLength(2);
      await expect(loadKeyring(serialized, NOW, length - 1)).rejects.toMatchObject({
        code: 'KEYRING_TOO_LARGE',
      });
    }
  });
  it.each([Number.NEGATIVE_INFINITY, 0, -1])(
    'E4: rejects invalid size bound %s before import',
    async (limit) => {
      const importer = vi.spyOn(crypto.subtle, 'importKey');
      await expect(loadKeyring(config(), NOW, limit)).rejects.toMatchObject({
        code: 'KEYRING_SCHEMA',
      });
      expect(importer).not.toHaveBeenCalled();
    },
  );
  it('E5: rejects invalid load and lookup clocks with stable errors', async () => {
    const importer = vi.spyOn(crypto.subtle, 'importKey');
    await expect(loadKeyring(config(), new Date(Number.NaN))).rejects.toMatchObject({
      code: 'KEYRING_SCHEMA',
    });
    expect(importer).not.toHaveBeenCalled();
    const loaded = await loadKeyring(config(), NOW);
    expect(() => loaded.activeFor(new Date(Number.NaN))).toThrow(EvidenceKeyringError);
  });
  it('E6: freezes the collection, entries, methods and key metadata without breaking crypto', async () => {
    const loaded = await loadKeyring(config(), NOW);
    const selected = loaded.activeFor(NOW);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.entries)).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Reflect.set(loaded.entries, '0', loaded.entries[1])).toBe(false);
    expect(Reflect.set(loaded, 'find', () => undefined)).toBe(false);
    for (const [field, value] of [
      ['cohort', '2099-02'],
      ['kekVersion', 'wrong'],
      ['active', false],
      ['key', loaded.entries[1]!.key],
    ] as const)
      expect(Reflect.set(selected, field, value)).toBe(false);
    expect(Reflect.set(selected.key, 'algorithm', { name: 'AES-CBC' })).toBe(false);
    expect(Reflect.set(selected.key.algorithm, 'length', 128)).toBe(false);
    selected.notBefore.setTime(0);
    selected.notAfter.setTime(0);
    expect(loaded.find('2099-01', 'synthetic-v1')).toBe(selected);
    expect(loaded.activeFor(NOW)).toBe(selected);
    expect(selected.notAfter.getTime()).toBeGreaterThan(NOW.getTime());
    const { wrapped, dek } = await createWrappedDek(selected.key, '2099-01', 'synthetic-v1');
    const moved = await rewrapDek(
      selected.key,
      wrapped,
      '2099-01',
      'synthetic-v1',
      loaded.entries[1]!.key,
      'synthetic-v2',
    );
    const restored = await unwrapDek(loaded.entries[1]!.key, moved, '2099-01', 'synthetic-v2');
    const binding = {
      table: 'stripe_provider_events',
      identity: 'synthetic-only',
      cohort: '2099-01',
      kekVersion: 'synthetic-v1',
    };
    const body = new TextEncoder().encode('synthetic-private-body');
    expect(await openPayload(restored, await sealPayload(dek, body, binding), binding)).toEqual(
      body,
    );
    expect(JSON.stringify(loaded)).not.toContain(rawKey);
  });
});
