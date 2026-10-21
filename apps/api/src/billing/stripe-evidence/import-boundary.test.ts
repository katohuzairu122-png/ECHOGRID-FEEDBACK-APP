import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * HETA-01-F1 T24 (import boundary), B5 (decrypt confined) and T25 (route enumeration), as a CI test that also covers
 * `export *` and dynamic imports, which the ESLint rule cannot.
 */
const API = resolve(__dirname, '../../..');
const SRC = join(API, 'src');
const EVIDENCE_DIR = join(SRC, 'billing', 'stripe-evidence');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (n === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

const files = [...walk(SRC), ...walk(join(API, 'scripts'))];
const rel = (f: string) => relative(API, f).split(sep).join('/');
const read = (f: string) => readFileSync(f, 'utf8');
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const inEvidence = (f: string) => f.startsWith(EVIDENCE_DIR + sep);
const isTest = (f: string) => f.endsWith('.test.ts');

const TABLES = ['stripeProviderEvents', 'stripeProviderMalformedReceipts', 'stripeProviderEventDispositions', 'stripeProviderEventConflicts', 'stripeEvidenceControlEvents', 'stripeEvidenceKeys'];
const SQL_TABLES = ['stripe_provider_events', 'stripe_provider_malformed_receipts', 'stripe_provider_event_dispositions', 'stripe_provider_event_conflicts', 'stripe_evidence_control_events', 'stripe_evidence_keys'];

describe('evidence import boundary (T24)', () => {
  it('no file outside the evidence module, the schema and tests references the six tables (by symbol or by raw SQL name)', () => {
    const offenders = files.filter(f => !inEvidence(f) && !isTest(f) && !f.includes(`${sep}db${sep}schema${sep}`)).filter(f => {
      const t = read(f);
      return [...TABLES, ...SQL_TABLES].some(n => new RegExp(`\\b${n}\\b`).test(t));
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it('the schema barrel is the only non-evidence file that re-exports the tables', () => {
    const exporters = files.filter(f => !inEvidence(f) && /export\s+\*\s+from\s+['"][^'"]*stripe-evidence['"]/.test(read(f))).map(rel);
    expect(exporters).toEqual(['src/db/schema/index.ts']);
  });
});

describe('decrypt is confined (B5)', () => {
  const importsOf = (name: string) => files.filter(f => !isTest(f) && !f.endsWith(`${sep}envelope.ts`) && new RegExp(`\\b${name}\\b`).test(code(f))).map(rel).sort();

  it('openPayload is used only by the forensic reader', () => {
    expect(importsOf('openPayload')).toEqual(['src/billing/stripe-evidence/forensic.ts']);
  });

  it('unwrapDek is used only where a DEK must be obtained: store (encrypt side), keyring operations, forensic reader', () => {
    expect(importsOf('unwrapDek')).toEqual(['src/billing/stripe-evidence/evidence.store.ts', 'src/billing/stripe-evidence/forensic.ts', 'src/billing/stripe-evidence/keyring-ops.ts']);
  });

  it('rewrapDek is used only by the operator keyring operations', () => {
    expect(importsOf('rewrapDek')).toEqual(['src/billing/stripe-evidence/keyring-ops.ts']);
  });

  it('the evidence barrel does not export any decrypt primitive', () => {
    const barrel = read(join(EVIDENCE_DIR, 'index.ts'));
    for (const n of ['openPayload', 'unwrapDek', 'rewrapDek']) expect(barrel.replace(/\/\/.*$/gm, ''), n).not.toMatch(new RegExp(`\\b${n}\\b`));
    expect(barrel).not.toMatch(/export\s+\*\s+from\s+['"]\.\/envelope['"]/);
  });

  it('the store exposes no read or decrypt method', () => {
    expect(read(join(EVIDENCE_DIR, 'evidence.store.ts'))).not.toMatch(/\basync\s+read[A-Za-z]*\(/);
  });
});

describe('route and job enumeration (T25)', () => {
  it('only the webhook route and the worker entry (heartbeat cron) import the evidence module from outside it', () => {
    const importers = files.filter(f => !inEvidence(f) && !isTest(f) && !rel(f).startsWith('src/db/schema/') && /from\s+['"][^'"]*stripe-evidence(?:\/[^'"]*)?['"]/.test(read(f))).map(rel).sort();
    expect(importers).toEqual(['scripts/stripe-evidence/attest.ts', 'scripts/stripe-evidence/forensic.ts', 'scripts/stripe-evidence/keyring.ts', 'scripts/stripe-evidence/reconcile.ts', 'src/billing/stripe-webhook.routes.ts', 'src/index.ts']);
  });

  it('no HTTP route file reaches the forensic reader or the operator libraries', () => {
    for (const f of files.filter(x => /\.routes\.ts$/.test(x) && !isTest(x))) {
      const t = read(f);
      for (const n of ['ForensicReader', 'keyring-ops', 'attestation', 'reconcile', 'rewrapCohort']) expect(t, `${rel(f)} mentions ${n}`).not.toContain(n);
    }
  });
});
