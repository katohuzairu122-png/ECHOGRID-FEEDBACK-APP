/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import {
  createEvidenceSigningBoundary, createEvidenceVerifier, createSigningWorkloadAuthority,
} from '../../src/billing/stripe-read';
import { randomBusinessId, syntheticDirectory, syntheticKey, syntheticSignerProvider, syntheticSigningWorkloadSource } from '../../src/billing/stripe-read/evidence-signing-test-support';

/**
 * S08-D1D3-DEV-14 on PostgreSQL: DEV-14 adds NO migration and NO table (signing workloads and key directories are trusted runtime configuration, private keys never touch the database). These tests prove that
 * from the catalog, prove that ordinary and administrator database logins cannot reach or change the activation policy or any signing-related configuration, and prove that running the whole sign/verify flow
 * leaves the policy, its audit trail and the financial ledger untouched. Disposable role, no Stripe, no production resource.
 */
describe.skipIf(!process.env.DATABASE_URL)('D1/D3-DEV-14 signing boundaries (integration)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const suffix = randomBytes(4).toString('hex');
  const adminLogin = `dev14_adm_${suffix}`; const plainLogin = `dev14_plain_${suffix}`; const pw = randomBytes(12).toString('hex');
  let root: Client; const clients: Client[] = [];
  const as = async (login: string) => { const u = new URL(base.toString()); u.username = login; u.password = pw; const c = new Client({ connectionString: u.toString() }); await c.connect(); clients.push(c); return c; };
  const tryQ = async (c: Client, text: string) => { try { return { error: '', rows: (await c.query(text)).rows as Array<Record<string, any>> }; } catch (e) { return { error: String((e as Error).message), rows: [] as Array<Record<string, any>> }; } };

  beforeAll(async () => {
    root = new Client({ connectionString: base.toString() }); await root.connect();
    await root.query(`create role ${adminLogin} login password '${pw}'`);
    await root.query(`create role ${plainLogin} login password '${pw}'`);
    await root.query(`grant stripe_read_auth_admin, stripe_read_auth_auditor to ${adminLogin}`);
  });
  afterAll(async () => {
    for (const c of clients) { try { await c.end(); } catch { /* closed */ } }
    for (const r of [adminLogin, plainLogin]) { try { await root.query(`drop role if exists ${r}`); } catch { /* shared cluster */ } }
    await root.end();
  });

  const snapshot = async () => ({
    policy: (await root.query('select approval_enabled, version from stripe_read_authorization_policy')).rows,
    changes: (await root.query('select count(*)::int n from stripe_read_policy_changes')).rows[0].n,
    events: (await root.query('select count(*)::int n from stripe_read_policy_events')).rows[0].n,
    ledger: (await root.query('select count(*)::int n from partner_credit_ledger')).rows[0].n,
  });

  it('no table or column stores private signing material: DEV-14 added no table, and the only key-ish columns are non-secret labels', async () => {
    const cols = (await root.query(`select table_name, column_name, data_type from information_schema.columns where table_schema='public' and (column_name ~* '(private|pkcs8|secret|signing_key|key_material|seed)')`)).rows;
    expect(cols.map(c => `${c.table_name}.${c.column_name}`).sort()).toEqual([
      'partner_credit_settlement_authorizations.signing_key_id', 'stripe_provider_event_conflicts.signing_secret_label', 'stripe_provider_events.signing_secret_label', 'stripe_provider_malformed_receipts.signing_secret_label',
    ]); // pre-existing identifiers/labels only (webhook secret LABELS, a public key id); nothing added by DEV-14
    expect(cols.every(c => c.data_type === 'text')).toBe(true); // identifiers/labels only
    expect((await root.query(`select 1 from information_schema.tables where table_schema='public' and table_name ~* '(signing_key|key_directory|signing_workload|private_key)'`)).rowCount).toBe(0);
  });

  it('ordinary and administrator database logins cannot change the activation policy or read policy administration data without a role; PUBLIC executes none of the policy functions', async () => {
    const before = await snapshot();
    expect(before.policy).toEqual([{ approval_enabled: false, version: before.policy[0].version }]);
    const adm = await as(adminLogin); const plain = await as(plainLogin);
    for (const c of [adm, plain]) {
      expect((await tryQ(c, 'update stripe_read_authorization_policy set approval_enabled = true')).error).toMatch(/permission denied/);
      expect((await tryQ(c, 'insert into stripe_read_authorization_policy(approval_enabled) values (true)')).error).toMatch(/permission denied/);
      expect((await tryQ(c, 'delete from stripe_read_authorization_policy')).error).toMatch(/permission denied/);
      expect((await tryQ(c, 'update stripe_read_authorization_policy set version = 99')).error).toMatch(/permission denied/);
      expect((await tryQ(c, 'truncate stripe_read_authorization_policy')).error).toMatch(/permission denied/);
    }
    expect((await tryQ(plain, 'select * from stripe_read_policy_changes')).error).toMatch(/permission denied/);
    expect((await tryQ(plain, 'select * from stripe_read_policy_events')).error).toMatch(/permission denied/);
    expect((await tryQ(plain, 'select * from stripe_read_authorization_policy')).error).toMatch(/permission denied/);
    expect((await tryQ(plain, "select public.stripe_read_policy_propose(gen_random_uuid(), true, 1, 'x', 1)")).error).toMatch(/permission denied/);
    expect((await root.query("select count(*)::int n from pg_proc p where proname like 'stripe_read_policy_%' and has_function_privilege('public', p.oid, 'EXECUTE')")).rows[0].n).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('the complete synthetic sign / verify / rotate / revoke flow changes nothing in the database: policy, policy audit and ledger are identical afterwards', async () => {
    const before = await snapshot();
    const biz = randomBusinessId(); let now = 500_000;
    const k1 = await syntheticKey({ keyId: 'k1' });
    let dir: unknown[] = [k1.record];
    const wl = { workloadId: 'signer:int', role: 'EVIDENCE_SIGNER', environment: 'development', purposes: ['SYNTHETIC_TEST_EVIDENCE'], businessIds: [biz], validFromMs: 1_000, expiresAtMs: 900_000, revokedAtMs: null };
    const authority = createSigningWorkloadAuthority({ source: syntheticSigningWorkloadSource('development', () => wl), environment: 'development', clock: () => now });
    const boundary = createEvidenceSigningBoundary({ authority, keys: syntheticDirectory(() => dir), signers: syntheticSignerProvider([k1]), environment: 'development', clock: () => now });
    const verifier = createEvidenceVerifier({ keys: syntheticDirectory(() => dir), clock: () => now });
    const s = await boundary.sign({ businessId: biz, purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE', payload: { a: 1 } });
    if (!s.ok) throw new Error(s.reason);
    expect(await verifier.verify(s.evidence, { businessId: biz, purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE', environment: 'development' })).toMatchObject({ ok: true, financialAuthorization: 'NOT_GRANTED' });
    dir = [{ ...k1.record, state: 'REVOKED', revokedAtMs: 510_000 }]; now = 520_000;
    expect(await verifier.verify(s.evidence, { businessId: biz, purpose: 'SYNTHETIC_TEST_EVIDENCE', evidenceType: 'SYNTHETIC_TEST_EVIDENCE', environment: 'development' })).toEqual({ ok: false, reason: 'KEY_REVOKED' });
    expect(await snapshot()).toEqual(before);
    expect(before.policy[0].approval_enabled).toBe(false);
  });
});
