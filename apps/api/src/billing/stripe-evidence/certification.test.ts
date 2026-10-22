import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CERT_DB_PATTERN, FORBIDDEN_DATABASES, GUARD_CONSTRAINTS, GUARD_TRIGGERS, LOCAL_TEST_ACK, checkTarget, clientConfig, evaluateCertification, readContract, readJournal,
} from '../../../scripts/verify-heta-f1-certification.mjs';

/**
 * HETA-01-F1 certification script and workflow: pure guard and evaluator behavior, plus static properties of both manual
 * workflow files. No database, no network. The end-to-end run is test/integration/heta-f1-certification.integration.test.ts.
 */
const HOST = 'ep-example-123456.c-10.us-east-1.aws.neon.tech';
const DB = 'echogrid_heta01_f1_cert_clean_01';
const url = (over: { host?: string; db?: string; query?: string; port?: string } = {}) =>
  `postgresql://owner:secret@${over.host ?? HOST}${over.port ? ':' + over.port : ''}/${over.db ?? DB}${over.query ?? '?sslmode=require'}`;
const expected = { host: HOST, database: DB };

describe('target guard (checkTarget)', () => {
  it('accepts exactly the expected direct, TLS Neon endpoint and certification database', () => {
    expect(checkTarget(url(), expected)).toEqual([]);
  });

  it.each([
    ['wrong host', url({ host: 'ep-other-1.c-10.us-east-1.aws.neon.tech' }), 'HOST_MISMATCH'],
    ['pooled endpoint', url({ host: 'ep-example-123456-pooler.c-10.us-east-1.aws.neon.tech' }), 'POOLED_ENDPOINT'],
    ['wrong database', url({ db: 'echogrid_heta01_f1_cert_other' }), 'DATABASE_MISMATCH'],
    ['sslmode missing', url({ query: '' }), 'SSLMODE'],
    ['sslmode prefer', url({ query: '?sslmode=prefer' }), 'SSLMODE'],
    ['options parameter', url({ query: '?sslmode=require&options=-c%20search_path%3Dpublic' }), 'OPTIONS_PARAMETER'],
    ['host override parameter', url({ query: '?sslmode=require&host=ep-other-1.c-10.us-east-1.aws.neon.tech' }), 'QUERY_PARAMETER_NOT_ALLOWED'],
    ['hostaddr override parameter', url({ query: '?sslmode=require&hostaddr=10.0.0.1' }), 'QUERY_PARAMETER_NOT_ALLOWED'],
    ['dbname override parameter', url({ query: '?sslmode=require&dbname=neondb' }), 'QUERY_PARAMETER_NOT_ALLOWED'],
    ['user override parameter', url({ query: '?sslmode=require&user=other' }), 'QUERY_PARAMETER_NOT_ALLOWED'],
    ['port override parameter', url({ query: '?sslmode=require&port=6543' }), 'QUERY_PARAMETER_NOT_ALLOWED'],
    ['ssl override parameter', url({ query: '?sslmode=require&ssl=false' }), 'QUERY_PARAMETER_NOT_ALLOWED'],
    ['service parameter', url({ query: '?sslmode=require&service=x' }), 'QUERY_PARAMETER_NOT_ALLOWED'],
    ['unknown parameter', url({ query: '?sslmode=require&application_name=x' }), 'QUERY_PARAMETER_NOT_ALLOWED'],
    ['duplicate sslmode (require first)', url({ query: '?sslmode=require&sslmode=disable' }), 'SSLMODE_DUPLICATE'],
    ['duplicate sslmode (require last)', url({ query: '?sslmode=disable&sslmode=require' }), 'SSLMODE_DUPLICATE'],
    ['non-default port', url({ port: '6543' }), 'PORT'],
    ['not a URL', 'not a url', 'URL_INVALID'],
    ['wrong protocol', url().replace('postgresql:', 'mysql:'), 'PROTOCOL'],
  ])('rejects %s', (_n, u, code) => {
    expect(checkTarget(u, expected)).toContain(code);
  });

  it.each(FORBIDDEN_DATABASES)('refuses the shared or completed-audit database name %s even when it is "expected"', name => {
    const f = checkTarget(url({ db: name }), { host: HOST, database: name });
    expect(f).toContain('DATABASE_FORBIDDEN');
    expect(f.length).toBeGreaterThan(1); // also fails the name pattern and the expected-database pattern
  });

  it('rejects an expected database that does not match the certification pattern, and a non-Neon host', () => {
    expect(checkTarget(url({ db: 'echogrid_staging' }), { host: HOST, database: 'echogrid_staging' })).toEqual(expect.arrayContaining(['EXPECTED_DATABASE_INVALID', 'DATABASE_PATTERN']));
    expect(checkTarget(url({ host: 'db.example.com' }), { host: 'db.example.com', database: DB })).toContain('HOST_NOT_NEON');
    expect(checkTarget(url(), {})).toEqual(expect.arrayContaining(['EXPECTED_HOST_INVALID', 'EXPECTED_DATABASE_INVALID']));
  });

  it('the local-test relaxation applies to localhost only, and never to a remote host', () => {
    const local = 'postgresql://postgres:pw@127.0.0.1:55432/echogrid_heta01_f1_cert_x';
    expect(checkTarget(local, { host: '127.0.0.1', database: 'echogrid_heta01_f1_cert_x' }, { localTest: true })).toEqual([]);
    expect(checkTarget(local, { host: '127.0.0.1', database: 'echogrid_heta01_f1_cert_x' })).toEqual(expect.arrayContaining(['HOST_NOT_NEON', 'SSLMODE', 'PORT']));
    expect(checkTarget(local + '?x=1', { host: '127.0.0.1', database: 'echogrid_heta01_f1_cert_x' }, { localTest: true })).toContain('QUERY_PARAMETER_NOT_ALLOWED');
    const remote = url({ query: '' });
    expect(checkTarget(remote, expected, { localTest: true })).toContain('SSLMODE');
    expect(LOCAL_TEST_ACK).toBe('I_ACKNOWLEDGE_LOCAL_DISPOSABLE');
  });

  it('the certification database pattern is narrow', () => {
    expect(CERT_DB_PATTERN.test('echogrid_heta01_f1_cert_clean_01')).toBe(true);
    for (const bad of ['echogrid_split07_cert_clean', 'neondb', 'echogrid_heta01_f1_cert_', 'echogrid_heta01_f1_cert_UPPER', 'echogrid_heta01_f1_cert_a-b']) expect(CERT_DB_PATTERN.test(bad)).toBe(false);
  });
});

describe('explicit client configuration (clientConfig)', () => {
  it('pins certificate and host-name verification regardless of the sslmode alias, and carries no connection string', () => {
    const c = clientConfig(url());
    expect(c).toEqual({ host: HOST, port: 5432, database: DB, user: 'owner', password: 'secret', ssl: { rejectUnauthorized: true, servername: HOST } });
    expect(Object.keys(c)).not.toContain('connectionString');
  });
  it('decodes credentials and honors an explicit port', () => {
    expect(clientConfig(`postgresql://o%40x:p%2Fw@${HOST}:5432/${DB}?sslmode=require`)).toMatchObject({ user: 'o@x', password: 'p/w', port: 5432 });
  });
  it('disables TLS only for the acknowledged localhost relaxation, never for a remote host', () => {
    const local = 'postgresql://postgres:pw@127.0.0.1:55432/echogrid_heta01_f1_cert_x';
    expect(clientConfig(local, { localTest: true }).ssl).toBe(false);
    expect(clientConfig(local).ssl).toMatchObject({ rejectUnauthorized: true });
    expect(clientConfig(url(), { localTest: true }).ssl).toMatchObject({ rejectUnauthorized: true });
  });
});

describe('certification evaluation (evaluateCertification)', () => {
  const journal = readJournal();
  const contract = readContract();
  const good = () => ({
    journal,
    applied: journal.map(j => ({ hash: j.sha256, createdAt: String(j.when) })),
    triggers: GUARD_TRIGGERS.map(tgname => ({ tgname, tgenabled: 'O' })),
    constraints: GUARD_CONSTRAINTS.map(conname => ({ conname, convalidated: true })),
    catalog: JSON.parse(JSON.stringify(contract.tables)) as Record<string, (typeof contract.tables)[string]>,
    contract,
  });

  it('the repository journal is complete, ordered, and hashed from the SQL files', () => {
    expect(journal.length).toBeGreaterThanOrEqual(47);
    expect(journal[46]!.tag).toMatch(/^0046_/); // the last migration known to the certification contract; later forward-only migrations may follow
    for (let i = 1; i < journal.length; i++) expect(journal[i]!.when).toBeGreaterThan(journal[i - 1]!.when);
    expect(journal.every(j => /^[0-9a-f]{64}$/.test(j.sha256))).toBe(true);
  });

  it('passes a faithful replay', () => {
    expect(evaluateCertification(good())).toEqual({ ok: true, failures: [] });
  });

  it('derives the expected count from the journal, never from a constant', () => {
    const g = good();
    g.applied = g.applied.slice(0, -1);
    expect(evaluateCertification(g).failures[0]).toMatch(/^COUNT_MISMATCH\(applied=\d+,journal=\d+\)$/);
  });

  it('detects a tampered migration hash, a reordered timestamp, and an extra recorded migration', () => {
    const a = good(); a.applied[10] = { ...a.applied[10]!, hash: 'f'.repeat(64) };
    expect(evaluateCertification(a).failures).toEqual([`HASH_MISMATCH(index=10,tag=${journal[10]!.tag})`]);
    const b = good(); b.applied[3] = { ...b.applied[3]!, createdAt: '1' };
    expect(evaluateCertification(b).failures).toEqual([`ORDER_MISMATCH(index=3,tag=${journal[3]!.tag})`]);
    const c = good(); c.applied.push({ hash: 'x', createdAt: '2' });
    expect(evaluateCertification(c).failures[0]).toMatch(/^COUNT_MISMATCH/);
  });

  it.each(GUARD_TRIGGERS)('detects the Partner Credit guard %s missing or not enabled', name => {
    const m = good(); m.triggers = m.triggers.filter(t => t.tgname !== name);
    expect(evaluateCertification(m).failures).toEqual([`GUARD_MISSING(${name})`]);
    const d = good(); d.triggers = d.triggers.map(t => (t.tgname === name ? { ...t, tgenabled: 'D' } : t));
    expect(evaluateCertification(d).failures).toEqual([`GUARD_NOT_ENABLED(${name})`]);
  });

  it.each(GUARD_CONSTRAINTS)('detects the conservation constraint %s missing or not validated', name => {
    const m = good(); m.constraints = m.constraints.filter(c => c.conname !== name);
    expect(evaluateCertification(m).failures).toEqual([`CONSTRAINT_MISSING(${name})`]);
    const n = good(); n.constraints = n.constraints.map(c => (c.conname === name ? { ...c, convalidated: false } : c));
    expect(evaluateCertification(n).failures).toEqual([`CONSTRAINT_NOT_VALIDATED(${name})`]);
  });

  it('detects evidence catalog drift in every aspect and a missing table', () => {
    const [table] = Object.keys(contract.tables) as [string];
    for (const aspect of ['columns', 'checks', 'uniques', 'foreignKeys', 'indexes', 'triggers'] as const) {
      const g = good();
      g.catalog[table] = { ...g.catalog[table]!, [aspect]: [...g.catalog[table]![aspect], 'unexpected_extra'] };
      expect(evaluateCertification(g).failures).toEqual([`CATALOG_DRIFT(${table}.${aspect})`]);
    }
    const g = good(); delete g.catalog[table];
    expect(evaluateCertification(g).failures).toEqual([`CATALOG_TABLE_MISSING(${table})`]);
  });
});

describe('workflow files (static)', () => {
  const root = resolve(__dirname, '../../../../..');
  const read = (n: string) => readFileSync(resolve(root, '.github/workflows', n), 'utf8');
  const heta = read('heta-f1-certification.yml');
  const split07 = read('split07-neon-certification.yml');
  const code = (s: string) => s.replace(/^\s*#.*$/gm, '');

  it('both certification workflows are manual-only with read-only repository permissions', () => {
    for (const w of [heta, split07]) {
      const c = code(w);
      expect(c).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
      for (const t of ['push:', 'pull_request:', 'schedule:', 'workflow_run:', 'repository_dispatch:']) expect(c, t).not.toContain(t);
      expect(c).toMatch(/permissions:\s*\n\s+contents: read/);
    }
  });

  it('the HETA workflow requires the reviewed commit, its own confirmation phrase and the exact target inputs', () => {
    const c = code(heta);
    expect(c).toContain('test "$CONFIRMATION" = HETA_F1_CERTIFY_CLEAN_DATABASE_ONLY');
    expect(c).toContain('[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]');
    expect(c).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT"');
    for (const input of ['expected_commit', 'confirmation', 'expected_host', 'expected_database']) expect(c).toMatch(new RegExp(`${input}:\\s*\\n\\s+description:[^\\n]*\\n\\s+required: true`));
  });

  it('it uses only its own secret, and nothing that can deploy or reach Stripe, Cloudflare, staging or production', () => {
    const c = code(heta);
    expect([...c.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1])).toEqual(['HETA_F1_CERT_DATABASE_URL']);
    for (const banned of ['wrangler', 'deploy', 'STRIPE', 'CLOUDFLARE', 'SPLIT07_CERT_DATABASE_URL', 'PRODUCTION', 'STAGING', 'migrate-production', 'migrate-staging']) expect(c, banned).not.toContain(banned);
  });

  it('it guards the target BEFORE migrating, certifies AFTER, and runs the existing verifiers', () => {
    const c = code(heta);
    const at = (s: string) => c.indexOf(s);
    expect(at('verify-heta-f1-certification.mjs guard')).toBeGreaterThan(0);
    expect(at('verify-heta-f1-certification.mjs guard')).toBeLessThan(at('db:migrate'));
    expect(at('db:migrate')).toBeLessThan(at('verify-heta-f1-certification.mjs certify'));
    for (const v of ['db:check', 'verify-heta-evidence-schema.mjs', 'verify-split07-disposable-postgres.mjs', 'test-split07-lock-concurrency.mjs']) expect(c, v).toContain(v);
  });

  it('the Split 07 workflow no longer hard-codes a migration count (H13)', () => {
    expect(code(split07)).not.toMatch(/assert\.equal\(count\.rows\[0\]\.n,\s*\d+\)/);
    expect(split07).toContain("entries.length");
    expect(split07).not.toMatch(/PASS: \d+ migrations/);
  });
});
