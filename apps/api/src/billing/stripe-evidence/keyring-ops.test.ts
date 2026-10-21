import { describe, it, expect } from 'vitest';
import { addKeyringEntry, assembleKeyring, completeRotation, generateKekEntry, importKek, CUSTODY_LOCATIONS, type KeyringEntryJson } from './keyring-ops';
import { loadKeyring, cohortOf } from './keyring';

const NOW = new Date('2026-10-15T12:00:00Z');
const entry = (cohort: string, version: string, active = true) => generateKekEntry({ cohort, kekVersion: version, active });
const threeMonths = () => [entry('2026-10', 'v1'), entry('2026-11', 'v1'), entry('2026-12', 'v1')];

describe('keyring generation and assembly (C.3)', () => {
  it('generates a random 32-byte KEK with a one-month window and distinct keys each time', () => {
    const a = generateKekEntry({ cohort: '2026-10', kekVersion: 'v1' });
    const b = generateKekEntry({ cohort: '2026-10', kekVersion: 'v1' });
    expect(Buffer.from(a.key, 'base64')).toHaveLength(32);
    expect(a.key).not.toBe(b.key);
    expect(a).toMatchObject({ cohort: '2026-10', kek_version: 'v1', alg: 'AES-256-GCM', active: true, not_before: '2026-10-01T00:00:00.000Z', not_after: '2026-11-01T00:00:00.000Z' });
  });

  it('rejects malformed cohort or version', () => {
    expect(() => generateKekEntry({ cohort: '2026-13', kekVersion: 'v1' })).toThrow();
    expect(() => generateKekEntry({ cohort: '2026-10', kekVersion: 'bad version!' })).toThrow();
    expect(() => generateKekEntry({ cohort: '2026-10', kekVersion: '' })).toThrow();
  });

  it('an assembled keyring loads in the Worker loader (the same fail-closed code path)', async () => {
    const k = await loadKeyring(assembleKeyring(threeMonths()), NOW);
    expect(k.activeFor(NOW).cohort).toBe('2026-10');
    expect(k.runwayCohorts(NOW)).toBe(2);
  });

  it('assembly enforces the entry-count limits, and the loader rejects a keyring without runway', async () => {
    expect(() => assembleKeyring([])).toThrow();
    expect(() => assembleKeyring(Array.from({ length: 9 }, (_, i) => entry('2026-10', `v${i}`)))).toThrow();
    await expect(loadKeyring(assembleKeyring([entry('2026-10', 'v1')]), NOW)).rejects.toMatchObject({ code: 'KEYRING_NO_RUNWAY' });
  });

  it('exposes only the documented custody locations', () => {
    expect([...CUSTODY_LOCATIONS]).toEqual(['worker_secret', 'primary_escrow', 'secondary_escrow', 'operator_forensic_env']);
  });

  it('imports a KEK as a non-extractable key and rejects a wrong length', async () => {
    expect((await importKek(entry('2026-10', 'v1'))).extractable).toBe(false);
    await expect(importKek({ ...entry('2026-10', 'v1'), key: Buffer.alloc(16).toString('base64') })).rejects.toThrow();
  });
});

describe('two-phase rotation of the keyring secret value (C.3)', () => {
  it('phase 1 adds the new entry INACTIVE so the cohort keeps exactly one active entry and the Worker keeps a usable KEK', async () => {
    const ring0 = assembleKeyring(threeMonths());
    const v2 = entry('2026-10', 'v2');
    const ring1 = addKeyringEntry(ring0, v2);
    const loaded = await loadKeyring(ring1, NOW);
    expect(loaded.activeFor(NOW).kekVersion).toBe('v1');
    expect(loaded.find('2026-10', 'v2')?.active).toBe(false);
    expect(JSON.parse(ring1).keys).toHaveLength(4);
  });

  it('phase 1 refuses a duplicate entry and a full keyring', () => {
    const ring0 = assembleKeyring(threeMonths());
    expect(() => addKeyringEntry(ring0, entry('2026-10', 'v1'))).toThrow(/already present/);
    const full = assembleKeyring(Array.from({ length: 8 }, (_, i) => entry(`2026-${String((i % 3) + 10).padStart(2, '0')}`, `x${i}`)));
    expect(() => addKeyringEntry(full, entry('2026-10', 'y'))).toThrow(/full/);
  });

  it('phase 2 removes the old entry and activates the new one atomically, leaving a valid keyring', async () => {
    const ring1 = addKeyringEntry(assembleKeyring(threeMonths()), entry('2026-10', 'v2'));
    const ring2 = completeRotation(ring1, '2026-10', 'v1', 'v2');
    const loaded = await loadKeyring(ring2, NOW);
    expect(loaded.find('2026-10', 'v1')).toBeUndefined();
    expect(loaded.activeFor(NOW).kekVersion).toBe('v2');
    const keys = (JSON.parse(ring2).keys as KeyringEntryJson[]).filter(k => k.cohort === '2026-10');
    expect(keys).toHaveLength(1);
    expect(cohortOf(NOW)).toBe('2026-10');
  });

  it('phase 2 requires both entries to be present', () => {
    const ring0 = assembleKeyring(threeMonths());
    expect(() => completeRotation(ring0, '2026-10', 'v1', 'v2')).toThrow();
    expect(() => completeRotation(ring0, '2026-10', 'v0', 'v1')).toThrow();
  });
});
