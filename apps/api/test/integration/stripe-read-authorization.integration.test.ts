/* eslint-disable @typescript-eslint/no-explicit-any -- tests build malformed rows and drive raw SQL deliberately */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { authorizeRead } from '../../src/billing/stripe-read/read-authorization';
import { checkRead } from '../../src/billing/stripe-read/read-gate';
import { MappingRegistry } from '../../src/billing/stripe-read/mapping-authority';
import { createDurableAuthorizationStore, ReadAuthorizationLifecycle, ReadAuthorizationLifecycleError, recordFromRow } from '../../src/billing/stripe-read/durable-authorization';
import { verifiedMapping } from '../../src/billing/stripe-read/pipeline-fixtures';

/**
 * S08-D1D3-DEV-10: the durable read authorization store, its lifecycle and its database privilege boundaries on PostgreSQL, in a SCRATCH database created and dropped here on the disposable server
 * named by DATABASE_URL (migration 0062 and every earlier migration applied). Real non-superuser logins prove the privilege matrix. No Stripe, provider, Neon or production resource.
 */
describe.skipIf(!process.env.DATABASE_URL)('D1/D3-DEV-10 durable Stripe read authorization (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_d10_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const PW = 'dev10-' + randomBytes(6).toString('hex');
  const clients: Client[] = [];
  let admin: Client;
  const connect = async () => { const c = new Client({ connectionString: urlFor(dbName) }); await c.connect(); clients.push(c); return c; };
  const connectAs = async (login: string) => { const u = new URL(urlFor(dbName)); u.username = login; u.password = PW; const c = new Client({ connectionString: u.toString() }); await c.connect(); clients.push(c); return c; };
  const q = async <T extends Record<string, any> = Record<string, any>>(text: string, params: unknown[] = []) => (await admin.query<T>(text, params)).rows;
  const tryQ = async (c: Client, text: string, params: unknown[] = []) => { try { return { error: '', rows: (await c.query(text, params)).rows as Array<Record<string, any>> }; } catch (e) { return { error: String((e as Error).message), rows: [] as Array<Record<string, any>> }; } };

  const WORKLOAD = 'wl-verifier-1';
  const ACCT = 'acct_Dev10Test1';
  const LOGINS: Record<string, string | null> = { dev10_l_admin: 'stripe_read_auth_admin', dev10_l_verifier: 'stripe_read_auth_verifier', dev10_l_tenant: 'stripe_read_auth_tenant_reader', dev10_l_auditor: 'stripe_read_auth_auditor', dev10_l_app: null, dev10_l_both: 'stripe_read_auth_admin' };
  let bizA: string; let bizB: string; let admin1: string; let admin2: string; let plain: string; let inactiveAdmin: string;
  let seq = 0;

  const mkBusiness = async () => (await q<{ id: string }>("insert into businesses(name,slug,status) values($1,$2,'active') returning id", [`D10 ${++seq}`, `d10-${dbName}-${seq}`]))[0]!.id;
  const mkUser = async (role: string | null, status = 'active') => (await q<{ id: string }>('insert into users(email,password_hash,full_name,status,platform_role) values($1,$2,$3,$4,$5) returning id', [`d10-${randomUUID()}@example.test`, 'x', 'D10 User', status, role]))[0]!.id;
  const lifecycleFor = async (login = 'dev10_l_admin') => new ReadAuthorizationLifecycle(buildDb(await connectAs(login)));
  const storeFor = async (login = 'dev10_l_verifier') => createDurableAuthorizationStore(buildDb(await connectAs(login)));
  const now = () => Date.now();
  const input = (over: Record<string, unknown> = {}) => ({ businessId: bizA, accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE' as const, validFromMs: now() - 1000, expiresAtMs: now() + 3_600_000, inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001', inventoryRevision: 'rev-1', ...over });
  const query = (over: Record<string, unknown> = {}) => ({ businessId: bizA, accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE', realm: 'test', ...over });
  const rejectsWith = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return e instanceof ReadAuthorizationLifecycleError ? e.code : String((e as Error).message); } };
  const setApproval = (on: boolean) => q('update stripe_read_authorization_policy set approval_enabled=$1', [on]);
  /** Proposes (admin1) and approves (admin2) a fresh authorization for a unique tuple. */
  const approved = async (over: Record<string, unknown> = {}) => {
    const lc = await lifecycleFor(); const id = await lc.propose(input({ accountId: `acct_Dev10${++seq}x`, ...over }) as any, admin1); await lc.approve(id, admin2, `EVIDENCE-${seq}`); return id;
  };

  beforeAll(async () => {
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`create database ${dbName}`); await root.end();
    const m = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
    if (m.status !== 0) throw new Error('scratch migrate failed: ' + m.stderr.slice(0, 400));
    admin = await connect();
    bizA = await mkBusiness(); bizB = await mkBusiness();
    admin1 = await mkUser('admin'); admin2 = await mkUser('admin'); plain = await mkUser(null); inactiveAdmin = await mkUser('admin', 'suspended');
    for (const [login, member] of Object.entries(LOGINS)) {
      await q(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}'`);
      await q(`GRANT CONNECT ON DATABASE ${dbName} TO ${login}`);
      if (member) await q(`GRANT ${member} TO ${login}`);
    }
    await q('GRANT stripe_read_auth_verifier TO dev10_l_both');
    // an ordinary application login: generous table grants like the real app role, none of the DEV-10 role memberships
    await q('GRANT ALL ON ALL TABLES IN SCHEMA public TO dev10_l_app'); await q('GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO dev10_l_app');
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect();
    await root.query(`drop database if exists ${dbName} with (force)`);
    for (const l of Object.keys(LOGINS)) { try { await root.query(`DROP OWNED BY ${l}`); await root.query(`DROP ROLE IF EXISTS ${l}`); } catch { /* shared cluster */ } }
    await root.end();
  });

  describe('approval authority (the write path is disabled by default)', () => {
    it('approval is DISABLED by default: a proposal can be made but cannot be approved, by any administrator, through the function or by direct SQL', async () => {
      expect((await q<{ approval_enabled: boolean }>('select approval_enabled from stripe_read_authorization_policy'))[0]!.approval_enabled).toBe(false);
      const lc = await lifecycleFor(); const id = await lc.propose(input({ accountId: 'acct_Dev10Off1' }) as any, admin1);
      expect(await rejectsWith(lc.approve(id, admin2, 'EVIDENCE-OFF'))).toBe('APPROVAL_DISABLED');
      const direct = await tryQ(admin, "update stripe_read_authorizations set state='APPROVED', version=2, approved_by=$2, approval_evidence_ref='X', approved_at_ms=0 where id=$1", [id, admin2]);
      expect(direct.error).toMatch(/READ_AUTH_APPROVAL_DISABLED/);
      expect((await q('select state from stripe_read_authorizations where id=$1', [id]))[0]!.state).toBe('PENDING');
      expect((await q("select count(*)::int n from stripe_read_authorization_policy"))[0]!.n).toBe(1);
      await setApproval(true); // the owner-side switch, flipped here only because this is a disposable database
    });

    it('untrusted callers cannot approve their own authorization, and only an active platform administrator can propose, approve or revoke', async () => {
      const lc = await lifecycleFor();
      expect(await rejectsWith(lc.propose(input({ accountId: 'acct_Dev10N1' }) as any, plain))).toBe('ADMIN_REQUIRED');
      expect(await rejectsWith(lc.propose(input({ accountId: 'acct_Dev10N2' }) as any, inactiveAdmin))).toBe('ADMIN_REQUIRED');
      const id = await lc.propose(input({ accountId: 'acct_Dev10N3' }) as any, admin1);
      expect(await rejectsWith(lc.approve(id, admin1, 'SELF'))).toBe('SELF_APPROVAL');
      expect(await rejectsWith(lc.approve(id, plain, 'PLAIN'))).toBe('ADMIN_REQUIRED');
      expect(await rejectsWith(lc.approve(id, inactiveAdmin, 'INACTIVE'))).toBe('ADMIN_REQUIRED');
      expect(await rejectsWith(lc.revoke(id, plain, 'NOT_ADMIN'))).toBe('ADMIN_REQUIRED');
      expect((await q('select state from stripe_read_authorizations where id=$1', [id]))[0]!.state).toBe('PENDING');
      // the actor is never a caller assertion that the database believes: an unknown id is not an administrator either
      expect(await rejectsWith(lc.approve(id, randomUUID(), 'GHOST'))).toBe('ADMIN_REQUIRED');
    });

    it('12. a duplicate approval is idempotent (same version, one audit event); a different approval of an approved record is refused', async () => {
      const lc = await lifecycleFor(); const id = await lc.propose(input({ accountId: 'acct_Dev10D1' }) as any, admin1);
      const v1 = await lc.approve(id, admin2, 'EVIDENCE-D'); const v2 = await lc.approve(id, admin2, 'EVIDENCE-D');
      expect([v1, v2]).toEqual([2, 2]);
      expect(await rejectsWith(lc.approve(id, admin2, 'EVIDENCE-OTHER'))).toBe('ALREADY_APPROVED');
      const ev = await q('select event_type, version, actor_id from stripe_read_authorization_events where authorization_id=$1 order by version', [id]);
      expect(ev.map(e => e.event_type)).toEqual(['PROPOSED', 'APPROVED']); expect(ev[1]!.actor_id).toBe(admin2);
    });

    it('13. concurrent approvals (different administrators, different evidence) cannot expand authority: exactly one wins, the audit trail has one approval', async () => {
      const id = await (await lifecycleFor()).propose(input({ accountId: 'acct_Dev10C1' }) as any, admin1);
      const lcs = await Promise.all(Array.from({ length: 6 }, () => lifecycleFor()));
      const out = await Promise.all(lcs.map((lc, i) => rejectsWith(lc.approve(id, i % 2 === 0 ? admin2 : (admin1 === admin2 ? admin2 : plain), `EV-${i}`).then(String))));
      const wins = out.filter(x => x === '' ); // approvals that resolved
      expect(wins.length).toBeLessThanOrEqual(1);
      const row = (await q('select state, version, approved_by, approval_evidence_ref from stripe_read_authorizations where id=$1', [id]))[0]!;
      expect(row.state).toBe('APPROVED'); expect(row.version).toBe(2);
      const ev = await q("select count(*)::int n from stripe_read_authorization_events where authorization_id=$1 and event_type='APPROVED'", [id]);
      expect(ev[0]!.n).toBe(1);
      // and two proposals for the same live tuple cannot both exist
      const lc = await lifecycleFor();
      const dup = await Promise.all([lc.propose(input({ accountId: 'acct_Dev10C2' }) as any, admin1).then(() => 'ok', (e: any) => e.code), lc.propose(input({ accountId: 'acct_Dev10C2' }) as any, admin2).then(() => 'ok', (e: any) => e.code)]);
      expect(dup.filter(x => x === 'ok')).toHaveLength(1); expect(dup).toContain('DUPLICATE_LIVE');
    });

    it('14. 15. a revocation is durable, concurrent revocations are idempotent, and a revoked authorization can never be reactivated (function, replay, direct SQL, or a new row for the same id)', async () => {
      const id = await approved({ accountId: 'acct_Dev10R1' });
      const lcs = await Promise.all(Array.from({ length: 4 }, () => lifecycleFor()));
      const versions = await Promise.all(lcs.map(lc => lc.revoke(id, admin1, 'OWNER_REQUEST')));
      expect(new Set(versions)).toEqual(new Set([3]));
      const row = (await q('select state, version, revoked_by from stripe_read_authorizations where id=$1', [id]))[0]!;
      expect([row.state, row.version, row.revoked_by]).toEqual(['REVOKED', 3, admin1]);
      expect((await q("select count(*)::int n from stripe_read_authorization_events where authorization_id=$1 and event_type='REVOKED'", [id]))[0]!.n).toBe(1);
      const lc = await lifecycleFor();
      expect(await rejectsWith(lc.approve(id, admin2, 'EVIDENCE-REPLAY'))).toBe('REVOKED_TERMINAL');
      expect(await tryQ(admin, "update stripe_read_authorizations set state='APPROVED', version=4 where id=$1", [id])).toMatchObject({ error: expect.stringMatching(/READ_AUTH_REVOKED_TERMINAL/) });
      expect(await tryQ(admin, "update stripe_read_authorizations set state='PENDING', version=4, revoked_by=null, revoked_at_ms=null, revoke_reason=null where id=$1", [id])).toMatchObject({ error: expect.stringMatching(/READ_AUTH_REVOKED_TERMINAL/) });
      expect((await q('select state from stripe_read_authorizations where id=$1', [id]))[0]!.state).toBe('REVOKED');
      // a revocation racing an approval ends in exactly one durable outcome, never an approved record that a reader can still use
      const id2 = await (await lifecycleFor()).propose(input({ accountId: 'acct_Dev10R2' }) as any, admin1);
      const [a, b] = await Promise.all([(await lifecycleFor()).approve(id2, admin2, 'EV-RACE').then(() => 'approved', (e: any) => e.code), (await lifecycleFor()).revoke(id2, admin1, 'RACE').then(() => 'revoked', (e: any) => e.code)]);
      const final = (await q('select state from stripe_read_authorizations where id=$1', [id2]))[0]!.state;
      expect(final).toBe('REVOKED'); expect([a, b].includes('revoked') || b === 'revoked').toBe(true);
      const store = await storeFor();
      const rows = await store.lookup({ businessId: bizA, methodId: 'INVOICE_RETRIEVE' });
      expect(rows.filter((r: any) => r.authorizationId === id2).every((r: any) => r.state === 'REVOKED')).toBe(true);
    });

    it('an expired authorization cannot be approved or renewed implicitly, and an already-expired authorization cannot even be proposed', async () => {
      const lc = await lifecycleFor();
      expect(await rejectsWith(lc.propose(input({ accountId: 'acct_Dev10E0', validFromMs: 1, expiresAtMs: 2 }) as any, admin1))).toBe('EXPIRED');
      const id = await lc.propose(input({ accountId: 'acct_Dev10E1', expiresAtMs: now() + 1200 }) as any, admin1);
      await new Promise(r => setTimeout(r, 1400));
      expect(await rejectsWith(lc.approve(id, admin2, 'EV-LATE'))).toBe('EXPIRED');
      // the expired PENDING record still occupies its live slot: a new grant needs an explicit revocation first, never an implicit renewal
      expect(await rejectsWith(lc.propose(input({ accountId: 'acct_Dev10E1' }) as any, admin1))).toBe('DUPLICATE_LIVE');
      await lc.revoke(id, admin1, 'EXPIRED_CLEANUP');
      const fresh = await lc.propose(input({ accountId: 'acct_Dev10E1' }) as any, admin1);
      expect(fresh).not.toBe(id);
    });

    it('every lifecycle change has immutable audit evidence: the trail is complete, digest-bearing and cannot be edited, deleted or truncated', async () => {
      const id = await approved({ accountId: 'acct_Dev10A1' }); await (await lifecycleFor()).revoke(id, admin1, 'AUDIT_CHECK');
      const ev = await q('select version, event_type, from_state, to_state, record_digest, actor_id from stripe_read_authorization_events where authorization_id=$1 order by version', [id]);
      expect(ev.map(e => [e.version, e.event_type, e.from_state, e.to_state])).toEqual([[1, 'PROPOSED', null, 'PENDING'], [2, 'APPROVED', 'PENDING', 'APPROVED'], [3, 'REVOKED', 'APPROVED', 'REVOKED']]);
      expect(new Set(ev.map(e => e.record_digest)).size).toBe(3);
      expect((await tryQ(admin, "update stripe_read_authorization_events set to_state='APPROVED' where authorization_id=$1", [id])).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      expect((await tryQ(admin, 'delete from stripe_read_authorization_events where authorization_id=$1', [id])).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      expect((await tryQ(admin, 'truncate stripe_read_authorization_events')).error).not.toBe('');
      expect((await tryQ(admin, 'delete from stripe_read_authorizations where id=$1', [id])).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      expect((await tryQ(admin, 'truncate stripe_read_authorizations cascade')).error).not.toBe('');
      expect((await tryQ(admin, 'delete from stripe_read_authorization_policy')).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      // even a session that tries to skip triggers cannot delete: the guards are ENABLE ALWAYS
      await admin.query('set session_replication_role = replica');
      expect((await tryQ(admin, 'delete from stripe_read_authorizations where id=$1', [id])).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      expect((await tryQ(admin, "update stripe_read_authorizations set state='APPROVED' where id=$1", [id])).error).toMatch(/READ_AUTH_REVOKED_TERMINAL|READ_AUTH_VERSION/);
      await admin.query('set session_replication_role = origin');
    });
  });

  describe('1-11. authorization storage: the durable store plugs into the unchanged enforcement and every uncertainty denies', () => {
    it('1-4. missing, pending, revoked and expired authorization deny', async () => {
      const store = await storeFor();
      const t0 = now();
      expect(await authorizeRead(store, query({ businessId: await mkBusiness() }), t0)).toEqual({ allowed: false, reason: 'AUTHORIZATION_MISSING' }); // 1
      const lc = await lifecycleFor();
      const pend = await lc.propose(input({ accountId: 'acct_Dev10S1' }) as any, admin1);
      expect(await authorizeRead(store, query({ accountId: 'acct_Dev10S1' }), t0)).toEqual({ allowed: false, reason: 'AUTHORIZATION_NOT_APPROVED' }); // 2
      await lc.revoke(pend, admin1, 'NEVER_APPROVED');
      expect(await authorizeRead(store, query({ accountId: 'acct_Dev10S1' }), t0)).toEqual({ allowed: false, reason: 'AUTHORIZATION_REVOKED' }); // 3
      const id = await approved({ accountId: 'acct_Dev10S2', expiresAtMs: t0 + 5000 });
      const ok = await authorizeRead(store, query({ accountId: 'acct_Dev10S2' }), t0 + 100);
      expect(ok).toMatchObject({ allowed: true, record: { authorizationId: id, state: 'APPROVED', version: 2, approvedBy: admin2 } });
      expect(await authorizeRead(store, query({ accountId: 'acct_Dev10S2' }), t0 + 5000)).toEqual({ allowed: false, reason: 'AUTHORIZATION_EXPIRED' }); // 4: derived, never stored
    });

    it('5-9. wrong business, account, workload, method and realm deny', async () => {
      const store = await storeFor();
      await approved({ accountId: 'acct_Dev10W1' });
      const base = query({ accountId: 'acct_Dev10W1' });
      expect((await authorizeRead(store, base, now())).allowed).toBe(true);
      expect(await authorizeRead(store, { ...base, businessId: bizB }, now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_MISSING' }); // 5: the lookup is tenant-scoped
      expect(await authorizeRead(store, { ...base, accountId: 'acct_Dev10Other' }, now())).toMatchObject({ allowed: false, reason: expect.stringMatching(/ACCOUNT_MISMATCH|AUTHORIZATION_MISSING/) }); // 6
      expect(await authorizeRead(store, { ...base, workloadId: 'wl-other' }, now())).toMatchObject({ allowed: false }); // 7
      expect(await authorizeRead(store, { ...base, methodId: 'ACCOUNT_RETRIEVE_CURRENT' }, now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_MISSING' }); // 8: only the method that was approved
      expect(await authorizeRead(store, { ...base, realm: 'live' }, now())).toEqual({ allowed: false, reason: 'REALM_NOT_TEST' }); // 9
      expect((await tryQ(admin, "insert into stripe_read_authorizations(business_id,account_id,realm,workload_id,method_id,state,valid_from_ms,expires_at_ms,inventory_record_id,inventory_revision,proposed_by) values($1,'acct_Dev10L','live',$2,'INVOICE_RETRIEVE','PENDING',1,9999999999999,'X','r',$3)", [bizA, WORKLOAD, admin1])).error).toMatch(/stripe_read_auth_realm_check/);
    });

    it('10. malformed records and rows deny (the strict parser fails the whole answer)', async () => {
      const bad: any[] = [{}, { ...recordFromRow({ authorization_id: randomUUID(), business_id: bizA, account_id: ACCT, realm: 'test', workload_id: WORKLOAD, method_id: 'INVOICE_RETRIEVE', state: 'APPROVED', approved_by: null, valid_from_ms: '1', expires_at_ms: '9999999999999', revoked_at_ms: null, version: 2, inventory_record_id: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001', inventory_revision: 'r' }) as object }];
      for (const row of [
        { state: 'MAYBE' }, { realm: 'live' }, { valid_from_ms: 'x' }, { expires_at_ms: null }, { version: 0 }, { method_id: 'REFUNDS_CREATE' }, { account_id: 'cus_1' },
      ]) {
        const good = { authorization_id: randomUUID(), business_id: bizA, account_id: ACCT, realm: 'test', workload_id: WORKLOAD, method_id: 'INVOICE_RETRIEVE', state: 'APPROVED', approved_by: admin2, valid_from_ms: '1', expires_at_ms: '9999999999999', revoked_at_ms: null, version: 2, inventory_record_id: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001', inventory_revision: 'r' };
        const fake: any = { transaction: async (fn: any) => fn({ execute: async (s: any) => (JSON.stringify(s).includes('set_config') ? { rows: [] } : { rows: [{ ...good, ...row }] }) }) };
        expect(await authorizeRead(createDurableAuthorizationStore(fake), query(), now()), JSON.stringify(row)).toEqual({ allowed: false, reason: 'AUTHORIZATION_MALFORMED' });
      }
      void bad;
    });

    it('11. a store failure denies: no database configuration, a failing handle, and a session that is not entitled to verify', async () => {
      expect(await authorizeRead(createDurableAuthorizationStore(undefined), query(), now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_STORE_UNAVAILABLE' });
      expect(await authorizeRead(createDurableAuthorizationStore(null), query(), now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_STORE_UNAVAILABLE' });
      const boom: any = { transaction: async () => { throw new Error('connection reset'); } };
      expect(await authorizeRead(createDurableAuthorizationStore(boom), query(), now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_STORE_UNAVAILABLE' });
      expect(await authorizeRead(createDurableAuthorizationStore(buildDb(await connectAs('dev10_l_app'))), query(), now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_STORE_UNAVAILABLE' }); // not a member of the verifier role
      expect(await authorizeRead(createDurableAuthorizationStore(buildDb(await connectAs('dev10_l_admin'))), query(), now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_STORE_UNAVAILABLE' }); // the administrator role cannot verify either
    });

    it('37. approving a method does not expand the capability registry: a record for any of the four unauthorized reads, or an unknown method, never authorizes anything', async () => {
      const store = await storeFor();
      for (const m of ['INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST'] as const) {
        const id = await approved({ accountId: 'acct_Dev10Q1', methodId: m });
        expect(await authorizeRead(store, query({ accountId: 'acct_Dev10Q1', methodId: m }), now()), m).toEqual({ allowed: false, reason: 'METHOD_NOT_AUTHORIZED' });
        const gate = { store, workloadId: WORKLOAD, mapping: verifiedMapping() };
        expect(await checkRead(gate as any, { businessId: bizA, accountId: 'acct_Dev10Q1', methodId: m, apiVersion: '2026-05-27.dahlia', purpose: 'EVIDENCE' }, now()), m).toMatchObject({ ok: false });
        void id;
      }
      expect((await tryQ(admin, "insert into stripe_read_authorizations(business_id,account_id,realm,workload_id,method_id,state,valid_from_ms,expires_at_ms,inventory_record_id,inventory_revision,proposed_by) values($1,'acct_Dev10Z','test',$2,'REFUNDS_CREATE','PENDING',1,9999999999999,'X','r',$3)", [bizA, WORKLOAD, admin1])).error).toMatch(/stripe_read_auth_method_check/);
      // the unchanged gate with an APPROVED record for an approved method still needs a VERIFIED MAPPING for evidence: authorization alone is never enough
      await approved({ accountId: 'acct_Dev10Q2' });
      expect(await checkRead({ store, workloadId: WORKLOAD, mapping: MappingRegistry.catalog() } as any, { businessId: bizA, accountId: 'acct_Dev10Q2', methodId: 'INVOICE_RETRIEVE', apiVersion: '2026-05-27.dahlia', purpose: 'EVIDENCE' }, now())).toEqual({ ok: false, reason: 'MAPPING_NOT_VERIFIED' });
    });

    it('28. revocation is enforced for the very next check with no cache: allowed, revoked, denied', async () => {
      const store = await storeFor(); const id = await approved({ accountId: 'acct_Dev10V1' });
      expect((await authorizeRead(store, query({ accountId: 'acct_Dev10V1' }), now())).allowed).toBe(true);
      await (await lifecycleFor()).revoke(id, admin1, 'OWNER_REQUEST');
      expect(await authorizeRead(store, query({ accountId: 'acct_Dev10V1' }), now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_REVOKED' });
    });
  });

  describe('16-23. database security: least privilege, RLS and direct-SQL resistance', () => {
    it('16-19. an ordinary application role cannot insert, update, delete or truncate any authorization table, directly or through the functions', async () => {
      const app = await connectAs('dev10_l_app');
      const id = await approved({ accountId: 'acct_Dev10P1' });
      for (const t of ['stripe_read_authorizations', 'stripe_read_authorization_events', 'stripe_read_authorization_policy']) {
        const sel = await tryQ(app, `select count(*)::int n from ${t}`);
        expect(sel.rows[0]?.n ?? 0, `${t} is hidden from an ordinary role by forced RLS`).toBe(0);
        expect((await tryQ(app, `delete from ${t}`)).rows.length).toBe(0);
        expect((await tryQ(app, `truncate ${t}`)).error, `truncate ${t}`).not.toBe('');
      }
      expect((await tryQ(app, "insert into stripe_read_authorizations(business_id,account_id,realm,workload_id,method_id,state,valid_from_ms,expires_at_ms,inventory_record_id,inventory_revision,proposed_by) values($1,'acct_Dev10P2','test',$2,'INVOICE_RETRIEVE','APPROVED',1,9999999999999,'X','r',$3)", [bizA, WORKLOAD, admin1])).error).not.toBe('');
      expect((await tryQ(app, "update stripe_read_authorizations set state='APPROVED' where id=$1", [id])).rows).toEqual([]);
      expect((await q('select state, version from stripe_read_authorizations where id=$1', [id]))[0]).toMatchObject({ state: 'APPROVED', version: 2 }); // unchanged by the attempt
      expect((await tryQ(app, "update stripe_read_authorization_policy set approval_enabled=true")).rows).toEqual([]);
      expect((await q('select approval_enabled from stripe_read_authorization_policy'))[0]!.approval_enabled).toBe(true); // still the value the test set as the owner
    });

    it('20. cross-tenant reads fail: the tenant reader sees only its own tenant, the verifier lookup is scoped to the business it names, and an unset tenant sees nothing', async () => {
      const lc = await lifecycleFor(); await lc.propose(input({ accountId: 'acct_Dev10T1', businessId: bizB }) as any, admin1);
      const tenant = await connectAs('dev10_l_tenant');
      expect((await tryQ(tenant, 'select count(*)::int n from stripe_read_authorizations')).rows[0]!.n).toBe(0); // no tenant set
      await tenant.query(`select set_config('echogrid.tenant_id', $1, false)`, [bizB]);
      const mine = await tryQ(tenant, 'select distinct business_id from stripe_read_authorizations'); expect(mine.rows.map(r => r.business_id)).toEqual([bizB]);
      expect((await tryQ(tenant, 'select count(*)::int n from stripe_read_authorization_events')).rows[0]!.n).toBeGreaterThan(0);
      await tenant.query(`select set_config('echogrid.tenant_id', $1, false)`, [randomUUID()]);
      expect((await tryQ(tenant, 'select count(*)::int n from stripe_read_authorizations')).rows[0]!.n).toBe(0);
      expect((await tryQ(tenant, "update stripe_read_authorizations set state='REVOKED'")).error).toMatch(/permission denied/);
      const store = await storeFor();
      const rowsB = (await store.lookup({ businessId: bizB, methodId: 'INVOICE_RETRIEVE' })) as any[];
      expect(rowsB.every(r => r.businessId === bizB)).toBe(true);
      expect((await store.lookup({ businessId: randomUUID(), methodId: 'INVOICE_RETRIEVE' }))).toEqual([]);
    });

    it('21. untrusted users cannot execute privileged functions: only the administrator role proposes, approves and revokes; only the verifier role looks up; internal functions are not callable', async () => {
      const id = await approved({ accountId: 'acct_Dev10X1' });
      const probes: Array<[string, string, unknown[]]> = [
        ['propose', 'select public.stripe_read_auth_propose($1::uuid,$2,$3,$4,1,9999999999999,$5::uuid,$6,$7)', [bizA, 'acct_Dev10X2', WORKLOAD, 'INVOICE_RETRIEVE', admin1, 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001', 'r']],
        ['approve', 'select public.stripe_read_auth_approve($1::uuid,$2::uuid,$3)', [id, admin2, 'EV']], ['revoke', 'select public.stripe_read_auth_revoke($1::uuid,$2::uuid,$3)', [id, admin1, 'X']],
        ['lookup', 'select * from public.stripe_read_auth_lookup($1::uuid,$2)', [bizA, 'INVOICE_RETRIEVE']],
        ['is_admin', 'select public.stripe_read_auth_is_admin($1::uuid)', [admin1]], ['now_ms', 'select public.stripe_read_auth_now_ms()', []], ['guard', 'select public.stripe_read_auth_guard()', []],
      ];
      for (const login of ['dev10_l_app', 'dev10_l_tenant', 'dev10_l_auditor']) {
        const c = await connectAs(login);
        for (const [name, text, params] of probes) expect((await tryQ(c, text, params)).error, `${login} ${name}`).toMatch(/permission denied|cannot be called|trigger functions/);
      }
      // the administrator role cannot read through the verifier path, and the verifier cannot write through the administrator path (set the role explicitly on each probe)
      const asRole = async (login: string, role: string, text: string, params: unknown[]) => { const c = await connectAs(login); await c.query('begin'); await c.query(`set local role ${role}`); const r = await tryQ(c, text, params); await c.query('rollback'); return r; };
      expect((await asRole('dev10_l_both', 'stripe_read_auth_admin', probes[3]![1], probes[3]![2])).error).toMatch(/permission denied/);
      for (const i of [0, 1, 2]) expect((await asRole('dev10_l_both', 'stripe_read_auth_verifier', probes[i]![1], probes[i]![2])).error, probes[i]![0]).toMatch(/permission denied/);
      expect((await asRole('dev10_l_both', 'stripe_read_auth_verifier', probes[3]![1], probes[3]![2])).error).toBe('');
      for (const i of [4, 5]) expect((await asRole('dev10_l_both', 'stripe_read_auth_admin', probes[i]![1], probes[i]![2])).error, probes[i]![0]).toMatch(/permission denied/);
      // the verifier has no table privilege at all
      for (const t of ['stripe_read_authorizations', 'stripe_read_authorization_events', 'stripe_read_authorization_policy']) expect((await asRole('dev10_l_both', 'stripe_read_auth_verifier', `select 1 from ${t}`, [])).error, t).toMatch(/permission denied/);
    });

    it('22. direct SQL cannot bypass the approval restrictions: the guard trigger applies to every writer, including the table owner and a superuser', async () => {
      const lc = await lifecycleFor(); const id = await lc.propose(input({ accountId: 'acct_Dev10B1' }) as any, admin1);
      const upd = (set: string, params: unknown[] = []) => tryQ(admin, `update stripe_read_authorizations set ${set} where id=$1`, [id, ...params]);
      expect((await upd("state='APPROVED', version=2, approved_by=$2, approval_evidence_ref='E', approved_at_ms=0", [plain])).error).toMatch(/READ_AUTH_ADMIN_REQUIRED/);
      expect((await upd("state='APPROVED', version=2, approved_by=$2, approval_evidence_ref='E', approved_at_ms=0", [admin1])).error).toMatch(/READ_AUTH_SELF_APPROVAL/);
      expect((await upd("state='APPROVED', version=5, approved_by=$2, approval_evidence_ref='E', approved_at_ms=0", [admin2])).error).toMatch(/READ_AUTH_VERSION/);
      expect((await upd("state='APPROVED', version=2, approved_by=$2, approval_evidence_ref=NULL, approved_at_ms=0", [admin2])).error).toMatch(/stripe_read_auth_state_fields_check/);
      expect((await upd("account_id='acct_Dev10Swapped'")).error).toMatch(/READ_AUTH_IMMUTABLE|READ_AUTH_VERSION/);
      expect((await upd("workload_id='wl-other', version=2")).error).toMatch(/READ_AUTH_IMMUTABLE/);
      expect((await upd("expires_at_ms=expires_at_ms+86400000, version=2")).error).toMatch(/READ_AUTH_IMMUTABLE/);
      expect((await upd("method_id='REFUNDS_LIST', version=2")).error).toMatch(/READ_AUTH_IMMUTABLE/);
      expect((await upd("state='PENDING', version=2")).error).toMatch(/READ_AUTH_INVALID_TRANSITION/);
      expect((await tryQ(admin, "insert into stripe_read_authorizations(business_id,account_id,realm,workload_id,method_id,state,version,valid_from_ms,expires_at_ms,inventory_record_id,inventory_revision,proposed_by,approved_by,approved_at_ms,approval_evidence_ref) values($1,'acct_Dev10B2','test',$2,'INVOICE_RETRIEVE','APPROVED',1,1,9999999999999,'X','r',$3,$4,1,'E')", [bizA, WORKLOAD, admin1, admin2])).error).toMatch(/READ_AUTH_INSERT_NOT_PENDING/);
      // timestamps are the server's, not the caller's
      const ok = await upd("state='APPROVED', version=2, approved_by=$2, approval_evidence_ref='E', approved_at_ms=12345", [admin2]);
      expect(ok.error).toBe('');
      const at = Number((await q('select approved_at_ms from stripe_read_authorizations where id=$1', [id]))[0]!.approved_at_ms);
      expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
      expect((await q('select count(*)::int n from stripe_read_authorization_events where authorization_id=$1', [id]))[0]!.n).toBe(2); // the audit row was written by the trigger even though the function was bypassed
      // a revocation cannot rewrite the approval evidence either
      expect((await upd("state='REVOKED', version=3, revoked_by=$2, revoked_at_ms=0, revoke_reason='REWRITE', approval_evidence_ref='FORGED'", [admin1])).error).toMatch(/READ_AUTH_IMMUTABLE/);
      expect((await upd("state='REVOKED', version=3, revoked_by=$2, revoked_at_ms=0, revoke_reason='REWRITE', approved_by=$3", [admin1, admin1])).error).toMatch(/READ_AUTH_IMMUTABLE/);
      expect((await q('select state from stripe_read_authorizations where id=$1', [id]))[0]!.state).toBe('APPROVED');
    });

    it('23. migration and application roles stay separated: the DEV-10 roles are NOLOGIN, non-superuser, non-BYPASSRLS, own nothing, hold exactly the privilege matrix, and every function has a fixed search path and no PUBLIC execute', async () => {
      const roles = await q("select rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole from pg_roles where rolname like 'stripe_read_auth_%' order by 1");
      expect(roles.map(r => r.rolname)).toEqual(['stripe_read_auth_admin', 'stripe_read_auth_auditor', 'stripe_read_auth_lifecycle', 'stripe_read_auth_tenant_reader', 'stripe_read_auth_verifier']);
      for (const r of roles) expect([r.rolsuper, r.rolbypassrls, r.rolcanlogin, r.rolcreaterole], r.rolname).toEqual([false, false, false, false]);
      const owners = await q("select c.relname, pg_get_userbyid(c.relowner) owner, c.relrowsecurity rls, c.relforcerowsecurity forced from pg_class c where c.relname in ('stripe_read_authorizations','stripe_read_authorization_events','stripe_read_authorization_policy')");
      for (const o of owners) { expect(o.owner, o.relname).not.toMatch(/^stripe_read_auth_/); expect([o.rls, o.forced], o.relname).toEqual([true, true]); }
      const fns = await q("select p.proname, pg_get_userbyid(p.proowner) owner, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') pub from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'stripe_read_auth_%'");
      expect(fns.length).toBe(10);
      for (const f of fns) {
        expect(f.pub, `${f.proname} must not be executable by PUBLIC`).toBe(false);
        if (f.prosecdef) { expect(f.owner, f.proname).toBe('stripe_read_auth_lifecycle'); expect(String(f.proconfig), f.proname).toMatch(/search_path=/); }
      }
      const priv = await q(`select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants where table_name like 'stripe_read_authoriz%' and grantee like 'stripe_read_auth_%' group by 1,2 order by 1,2`);
      const m = Object.fromEntries(priv.map(r => [`${r.grantee}:${r.table_name}`, r.p]));
      expect(m['stripe_read_auth_lifecycle:stripe_read_authorizations']).toBe('INSERT,SELECT,UPDATE');
      expect(m['stripe_read_auth_lifecycle:stripe_read_authorization_events']).toBe('INSERT,SELECT');
      expect(Object.keys(m).filter(k => k.startsWith('stripe_read_auth_verifier') || k.startsWith('stripe_read_auth_admin'))).toEqual([]);
      for (const k of Object.keys(m)) expect(m[k], k).not.toMatch(/DELETE|TRUNCATE|REFERENCES|TRIGGER/);
      // the lifecycle role can see only the four user columns that identify an administrator, never a credential or a contact
      const col = (c: string) => q<{ ok: boolean }>(`select has_column_privilege('stripe_read_auth_lifecycle','users','${c}','SELECT') ok`).then(r => r[0]!.ok);
      expect(await Promise.all(['id', 'status', 'platform_role', 'deleted_at'].map(col))).toEqual([true, true, true, true]);
      expect(await Promise.all(['password_hash', 'email', 'phone', 'full_name'].map(col))).toEqual([false, false, false, false]);
      const login = await connectAs('dev10_l_both');
      expect((await tryQ(login, 'select rolsuper, rolbypassrls from pg_roles where rolname = current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });
});
