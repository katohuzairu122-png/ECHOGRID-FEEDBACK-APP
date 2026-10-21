import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { LOCAL_TEST_ACK, readJournal } from '../../scripts/verify-heta-f1-certification.mjs';

/**
 * HETA-01-F1 certification script, end to end against SCRATCH databases created and dropped here on the disposable server
 * named by DATABASE_URL. Nothing touches the main test database's data. No Neon, Stripe or Cloudflare. The scratch
 * databases' migration BOOKKEEPING rows are altered only to prove tampering is detected; no guard or constraint is disabled.
 */
describe.skipIf(!process.env.DATABASE_URL)('HETA-01-F1 certification script (integration, scratch databases)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const suffix = randomBytes(4).toString('hex');
  const names = { clean: `echogrid_heta01_f1_cert_clean_${suffix}`, dirty: `echogrid_heta01_f1_cert_dirty_${suffix}` };
  const urlFor = (db: string) => { const u = new URL(base.toString()); u.pathname = `/${db}`; return u.toString(); };
  let admin: Client;

  const run = (cmd: string[], db: string, extra: Record<string, string | undefined> = {}) =>
    spawnSync(cmd[0]!, cmd.slice(1), {
      cwd: api, encoding: 'utf8', timeout: 240_000,
      env: { ...process.env, DATABASE_URL: urlFor(db), EXPECTED_HOST: base.hostname, EXPECTED_DATABASE: db, HETA_F1_CERT_LOCAL_TEST: LOCAL_TEST_ACK, ...extra },
    });
  const script = (phase: 'guard' | 'certify', db: string, extra: Record<string, string | undefined> = {}) => {
    const r = run(['node', 'scripts/verify-heta-f1-certification.mjs', phase], db, extra);
    return { status: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop() || '{}') as { ok?: boolean; failures?: string[]; migrations?: number; journalEntries?: number; guards?: number; constraints?: number; evidenceTables?: number; tls?: boolean }, raw: r.stdout + r.stderr };
  };
  const onDb = async (db: string, sql: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: urlFor(db) });
    await c.connect();
    try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    for (const n of Object.values(names)) await admin.query(`create database ${n}`);
  });
  afterAll(async () => {
    for (const n of Object.values(names)) await admin.query(`drop database if exists ${n} with (force)`);
    await admin.end();
  });

  it('guard passes on an EMPTY pinned database and prints no connection details', () => {
    const r = script('guard', names.clean);
    expect(r.status).toBe(0);
    expect(r.out).toMatchObject({ ok: true, failures: [] });
    if (base.password && base.password.length >= 8) expect(r.raw).not.toContain(base.password);
    expect(r.raw).not.toContain(urlFor(names.clean));
  });

  it('guard refuses a non-empty database and a database whose journal exists', async () => {
    await onDb(names.dirty, 'create table stray(id int)');
    const r = script('guard', names.dirty);
    expect(r.status).toBe(2);
    expect(r.out.failures).toEqual(['NOT_EMPTY(public_tables=1)']);
  });

  it('guard refuses wrong pinning, a pre-existing shared database, and the relaxation without its acknowledgement', () => {
    expect(script('guard', names.clean, { EXPECTED_DATABASE: 'echogrid_heta01_f1_cert_other' }).out.failures).toContain('TARGET_DATABASE_MISMATCH');
    expect(script('guard', names.clean, { EXPECTED_HOST: 'localhost-not-the-host' }).out.failures).toContain('TARGET_HOST_MISMATCH');
    const shared = run(['node', 'scripts/verify-heta-f1-certification.mjs', 'guard'], 'postgres', { EXPECTED_DATABASE: 'postgres' });
    expect(shared.status).toBe(2);
    expect(shared.stdout).toContain('TARGET_DATABASE_FORBIDDEN');
    const strict = script('guard', names.clean, { HETA_F1_CERT_LOCAL_TEST: undefined });
    expect(strict.status).toBe(2);
    expect(strict.out.failures).toEqual(expect.arrayContaining(['TARGET_HOST_NOT_NEON', 'TARGET_SSLMODE']));
  });

  it('missing configuration is a failure, not a pass', () => {
    const r = spawnSync('node', ['scripts/verify-heta-f1-certification.mjs', 'guard'], { cwd: api, encoding: 'utf8', env: { ...process.env, DATABASE_URL: '', EXPECTED_HOST: undefined, EXPECTED_DATABASE: undefined } });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('TARGET_URL_INVALID');
    expect(spawnSync('node', ['scripts/verify-heta-f1-certification.mjs', 'bogus'], { cwd: api, encoding: 'utf8' }).status).toBe(1);
  });

  it('migrates the clean database with the repository journal, then certifies it: history, hashes, guards, constraints, catalog', () => {
    const m = run(['pnpm', 'exec', 'drizzle-kit', 'migrate'], names.clean);
    expect(m.status, m.stdout + m.stderr).toBe(0);
    const r = script('certify', names.clean);
    expect(r.status, JSON.stringify(r.out)).toBe(0);
    expect(r.out).toMatchObject({ ok: true, failures: [], migrations: readJournal().length, journalEntries: readJournal().length, guards: 5, constraints: 4, evidenceTables: 6 });
  });

  it('after migration the guard now refuses the same database (it is no longer clean)', () => {
    const r = script('guard', names.clean);
    expect(r.status).toBe(2);
    expect(r.out.failures).toEqual(expect.arrayContaining([expect.stringMatching(/^NOT_EMPTY/)]));
  });

  it('certify detects a tampered recorded migration hash, a missing history row and a changed timestamp, each exactly', async () => {
    const journal = readJournal();
    const rows = await onDb(names.clean, 'select id, hash, created_at from drizzle.__drizzle_migrations order by id');
    const last = rows[rows.length - 1]!;
    try {
      await onDb(names.clean, `update drizzle.__drizzle_migrations set hash = repeat('f',64) where id = $1`, [rows[2]!.id]);
      const a = script('certify', names.clean);
      expect(a.status).toBe(2);
      expect(a.out.failures).toEqual([`HASH_MISMATCH(index=2,tag=${journal[2]!.tag})`]);
    } finally {
      await onDb(names.clean, 'update drizzle.__drizzle_migrations set hash = $1 where id = $2', [rows[2]!.hash, rows[2]!.id]);
    }
    try {
      await onDb(names.clean, 'delete from drizzle.__drizzle_migrations where id = $1', [last.id]);
      const b = script('certify', names.clean);
      expect(b.status).toBe(2);
      expect(b.out.failures![0]).toMatch(/^COUNT_MISMATCH\(applied=\d+,journal=\d+\)$/);
    } finally {
      await onDb(names.clean, 'insert into drizzle.__drizzle_migrations (id, hash, created_at) overriding system value values ($1,$2,$3)', [last.id, last.hash, last.created_at]).catch(async () => {
        await onDb(names.clean, 'insert into drizzle.__drizzle_migrations (id, hash, created_at) values ($1,$2,$3)', [last.id, last.hash, last.created_at]);
      });
    }
    try {
      await onDb(names.clean, 'update drizzle.__drizzle_migrations set created_at = 1 where id = $1', [rows[5]!.id]);
      const c = script('certify', names.clean);
      expect(c.out.failures).toEqual([`ORDER_MISMATCH(index=5,tag=${journal[5]!.tag})`]);
    } finally {
      await onDb(names.clean, 'update drizzle.__drizzle_migrations set created_at = $1 where id = $2', [rows[5]!.created_at, rows[5]!.id]);
    }
    expect(script('certify', names.clean).status).toBe(0); // the bookkeeping is restored exactly
  });

  it('certify detects a dropped evidence constraint through the catalog contract (scratch database only)', async () => {
    await onDb(names.clean, 'alter table stripe_evidence_keys drop constraint stripe_evidence_keys_algorithm_check');
    const r = script('certify', names.clean);
    expect(r.status).toBe(2);
    expect(r.out.failures).toEqual(['CATALOG_DRIFT(stripe_evidence_keys.checks)']);
  });
});
