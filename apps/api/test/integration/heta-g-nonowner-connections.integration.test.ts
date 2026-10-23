import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { HetaRevisionChain, HetaWorkQueue } from '../../src/billing/stripe-evidence/persisted-reconciliation';
import { createBenefitScratch } from './helpers/benefit-scratch';

/**
 * HETA G6 (non-owner isolation) for the Block G persisted tables: the role asset is applied to a scratch database, then REAL LOGIN roles that are members
 * of the group roles connect over TCP (not SET ROLE from a superuser) and the application classes run through them. LOGIN roles and their passwords exist
 * only here, only on the disposable server, and are dropped afterwards. Nothing creates a login role in the asset itself.
 */
type Scratch = Awaited<ReturnType<typeof createBenefitScratch>>;
let s: Scratch;
const pw = 'g6-' + Math.random().toString(36).slice(2);
const LOGINS = { rec: 'heta_g_login_rec', att: 'heta_g_login_att', ten: 'heta_g_login_ten', for: 'heta_g_login_for' } as const;
const MEMBER: Record<keyof typeof LOGINS, string> = { rec: 'heta_reconciler', att: 'heta_attestation', ten: 'heta_tenant_projection', for: 'heta_forensic_reader' };
const sqlText = readFileSync(resolve(__dirname, '../../scripts/sql/heta-evidence-least-privilege.sql'), 'utf8');
const conns: Client[] = [];
const as = async (k: keyof typeof LOGINS) => {
  const u = new URL(s.urlFor(s.dbName)); u.username = LOGINS[k]; u.password = pw;
  const c = new Client({ connectionString: u.toString() }); await c.connect(); conns.push(c); return c;
};
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'err'; } };

beforeAll(async () => {
  s = await createBenefitScratch('hgr');
  await s.admin.query(sqlText);
  for (const k of Object.keys(LOGINS) as (keyof typeof LOGINS)[]) {
    await s.admin.query(`DROP ROLE IF EXISTS ${LOGINS[k]}`);
    await s.admin.query(`CREATE ROLE ${LOGINS[k]} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS`);
    await s.admin.query(`GRANT ${MEMBER[k]} TO ${LOGINS[k]}`);
    await s.admin.query(`GRANT CONNECT ON DATABASE ${s.dbName} TO ${LOGINS[k]}`);
  }
}, 300_000);
afterAll(async () => {
  for (const c of conns) await c.end().catch(() => undefined);
  if (s) {
    await s.close();
  }
  const root = new Client({ connectionString: new URL(process.env.DATABASE_URL!).toString() });
  await root.connect();
  for (const l of Object.values(LOGINS)) await root.query(`DROP ROLE IF EXISTS ${l}`).catch(() => undefined);
  for (const r of ['heta_receipt_writer', 'heta_attestation', 'heta_reconciler', 'heta_tenant_projection', 'heta_forensic_reader']) await root.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
  await root.end();
});

describe('G6 non-owner connections to the Block G tables', () => {
  it('the connecting roles are genuinely non-owner, non-superuser and subject to RLS', async () => {
    for (const k of Object.keys(LOGINS) as (keyof typeof LOGINS)[]) {
      const c = await as(k);
      const r = (await c.query("select rolsuper, rolbypassrls, (select count(*)::int from pg_class where relname like 'heta\\_%' and pg_get_userbyid(relowner)=current_user) owned from pg_roles where rolname=current_user")).rows[0];
      expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false, owned: 0 });
    }
  });

  it('reconciler login runs the work queue and records revisions end to end; fenced and guarded as before', async () => {
    const c = await as('rec');
    const q = new HetaWorkQueue(buildDb(c));
    const e = await q.enqueue({ kind: 'retrieve_event', subjectKey: 'evt_nonowner' });
    const [w] = await q.claim({ owner: 'rec', leaseMs: 60_000, kinds: ['retrieve_event'] });
    expect(w!.id).toBe(e.id);
    expect(await q.complete(w!.id, w!.leaseToken)).toBe(true);
    expect(await code(c.query('delete from heta_reconciliation_work'))).toBe('42501');
    expect(await code(c.query('truncate heta_reconciliation_work'))).toBe('42501');
    expect(await code(c.query("update heta_reconciliation_work set state='pending' where id=$1", [w!.id]))).toBe('P0001'); // allowed by grant, refused by the terminal-state guard
    const chain = new HetaRevisionChain(buildDb(c));
    const r1 = await chain.append('nonowner:1', { state: 'active', effectiveFrom: new Date(Date.now() - 1000) }, null);
    expect(r1.ok).toBe(true);
    expect(await code(c.query("update heta_record_revisions set state='revoked'"))).toBe('42501');
  });

  it('attestation login can append revisions and nothing else', async () => {
    const c = await as('att');
    const chain = new HetaRevisionChain(buildDb(c));
    const head = (await chain.read('nonowner:1'))[0]!;
    expect((await chain.append('nonowner:1', { state: 'revoked', effectiveFrom: new Date() }, head.id)).ok).toBe(true);
    for (const t of ['heta_reconciliation_work', 'heta_provenance_comparisons', 'stripe_provider_events', 'stripe_evidence_keys'])
      expect(await code(c.query(`select 1 from ${t} limit 1`))).toBe('42501');
    expect(await code(c.query("insert into heta_reconciliation_work(kind,subject_key,dedupe_key) values('retrieve_event','x','retrieve_event:x')"))).toBe('42501');
  });

  it('forensic login reads everything and writes nothing; tenant-projection login sees none of it', async () => {
    const f = await as('for');
    for (const t of ['heta_reconciliation_work', 'heta_provenance_comparisons', 'heta_record_revisions']) expect(await code(f.query(`select 1 from ${t} limit 1`))).toBe('ok');
    expect(await code(f.query("insert into heta_record_revisions(scope_key,revision,state,effective_from) values('f',1,'active',now())"))).toBe('42501');
    const t = await as('ten');
    for (const tbl of ['heta_reconciliation_work', 'heta_provenance_comparisons', 'heta_record_revisions', 'stripe_provider_events']) expect(await code(t.query(`select 1 from ${tbl} limit 1`))).toBe('42501');
  });

  it('RLS is the second wall: a role with a stray broad GRANT but no policy still sees zero rows', async () => {
    await s.admin.query('GRANT SELECT ON heta_record_revisions TO heta_tenant_projection');
    try {
      const t = await as('ten');
      expect((await t.query('select count(*)::int n from heta_record_revisions')).rows[0].n).toBe(0);
      expect((await s.admin.query('select count(*)::int n from heta_record_revisions')).rows[0].n).toBeGreaterThan(0);
    } finally { await s.admin.query('REVOKE SELECT ON heta_record_revisions FROM heta_tenant_projection'); }
  });
});
