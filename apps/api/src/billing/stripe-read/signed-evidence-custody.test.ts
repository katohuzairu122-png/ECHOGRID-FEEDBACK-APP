/* eslint-disable @typescript-eslint/no-explicit-any -- forged-input fixtures */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SignedEvidenceCustodyService, contentDigest, createSigningWorkloadAuthority } from './index';
import { randomBusinessId, syntheticSigningWorkloadSource } from './evidence-signing-test-support';

/**
 * S08-D1D3-DEV-15 (unit): the custody service validates every input before it can reach the database, its digest is a fixed-vector contract with the SQL function, and it stays isolated from every financial,
 * settlement, policy, Stripe and route module. The database behavior is covered by the PostgreSQL integration suite.
 */
const dir = resolve(__dirname);
const BIZ = randomBusinessId();
const boom = new Proxy({}, { get() { throw new Error('the database must not be touched'); } }) as any;
const svc = () => new SignedEvidenceCustodyService({
  db: boom, keys: { load: async () => { throw new Error('no key directory'); } }, environment: 'development', clock: () => 500_000, securityLog: () => undefined,
  authority: createSigningWorkloadAuthority({ source: syntheticSigningWorkloadSource('development', () => null), environment: 'development', clock: () => 500_000, role: 'EVIDENCE_CUSTODIAN' }),
});
const exp = { businessId: BIZ, purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE' };

describe('DEV-15 custody service (unit)', () => {
  it('rejects malformed requests and unconfigured authority without touching the database', async () => {
    for (const bad of [null, undefined, 1, [], {}, { evidenceId: 'x', expected: exp, evidence: {} }, { evidenceId: randomUUID(), expected: { ...exp, purpose: 'X' }, evidence: {} }, { evidenceId: randomUUID(), expected: exp, evidence: {}, extra: 1 }]) {
      expect(await svc().persist(bad as any)).toEqual({ ok: false, reason: 'INVALID_REQUEST' });
    }
    for (const bad of [null, {}, { evidenceId: 'x', ...exp }, { evidenceId: randomUUID(), ...exp, extra: 1 }]) expect(await svc().retrieve(bad as any)).toEqual({ ok: false, reason: 'INVALID_REQUEST' });
    // valid shape, but no trusted custodian is configured: fail closed before any store or key access
    expect(await svc().persist({ evidenceId: randomUUID(), expected: exp as any, evidence: {} as any })).toEqual({ ok: false, reason: 'SIGNER_CONFIG_MISSING' });
    expect(await svc().retrieve({ evidenceId: randomUUID(), ...exp } as any)).toEqual({ ok: false, reason: 'SIGNER_CONFIG_MISSING' });
  });

  it('the content digest is a byte-length-prefixed contract (fixed vector, multi-byte safe)', async () => {
    const f = { businessId: '11111111-1111-4111-8111-111111111111', signerWorkloadId: 'signer:x', environment: 'development', purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE', schema: 'S08-SIGNED-EVIDENCE', schemaVersion: 1, signedAtMs: 5, keyId: 'k', keyVersion: 1, algorithm: 'Ed25519', payloadSha256: 'a'.repeat(64), signature: 'b'.repeat(128), payloadCanonical: '{"a":"é"}' };
    const d = await contentDigest(f);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(await contentDigest(f)).toBe(d);
    for (const k of Object.keys(f) as Array<keyof typeof f>) expect(await contentDigest({ ...f, [k]: typeof f[k] === 'number' ? (f[k] as number) + 1 : `${f[k]}x` })).not.toBe(d); // every field is bound
    expect(await contentDigest({ ...f, keyId: 'k1', keyVersion: 1, algorithm: 'Ed25519' })).not.toBe(await contentDigest({ ...f, keyId: 'k', keyVersion: 11, algorithm: 'Ed25519' })); // no ambiguity at field boundaries
  });

  it('is isolated from financial, settlement, policy, Stripe, environment and route code, and the migration cannot reach them', () => {
    const src = readFileSync(join(dir, 'signed-evidence-custody.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/approval_enabled|stripe_read_authorization_policy|policy-activation|policy-administration|activatePolicy|partner_credit|ledger|settlement|consum|process\.env|\bfetch\(|https?:\/\//);
    const allowed = ['drizzle-orm', '../../db/client', './bundle-builder', './evidence-signing-keys', './evidence-signing-workload', './evidence-signing', './workload-identity'];
    for (const m of src.matchAll(/from '([^']+)'/g)) expect(allowed, `imports ${m[1]}`).toContain(m[1]);
    const sql = readFileSync(resolve(dir, '../../../drizzle/0065_d1d3_dev15_signed_evidence_custody.sql'), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/partner_credit|approval_enabled|stripe_read_authorization|stripe_read_policy|settlement_/);
    expect(sql).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*TO\s+signed_evidence/i);
    expect(sql).not.toMatch(/GRANT[^;]*\bTO\s+PUBLIC\b/i);
    // nothing outside the custody module (and its tests) imports it: no route, no financial module
    const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
    for (const f of walk(resolve(dir, '../..'))) {
      if (/stripe-read\/(signed-evidence-custody|index)\.ts$/.test(f) || f.endsWith('.test.ts') || f.includes('/db/schema/')) continue; // the schema file of the same name defines tables only
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/stripe-read\/signed-evidence-custody|SignedEvidenceCustodyService/);
    }
  });
});
