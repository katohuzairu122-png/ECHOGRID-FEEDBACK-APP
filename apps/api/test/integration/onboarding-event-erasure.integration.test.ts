import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { ONBOARDING_INVITE_TTL_SECONDS } from '../../src/customer-relationships/onboarding-attribution';

/**
 * CASHIER-PROD-D2-R1 against REAL PostgreSQL: controlled anonymization of onboarding events (migration 0084).
 * Development evidence only: it runs on a disposable local database. It proves the ordinary append-only guarantee is intact, that the one
 * sanctioned transition is reachable only through the restricted function (and shape-checked even for the function's own role), that the
 * function is scoped to one business and one customer, that it is idempotent, atomic and safe against the membership lifecycle locks, and that
 * the audit row holds no personal data. Policy decisions (retention period, trigger, cashier treatment default, granularity) are NOT decided here.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Onboarding erasure tests need a loopback PostgreSQL database.');
}

const run = randomUUID().replace(/-/g, '').slice(0, 10);
const FN = 'public.onboarding_erase_customer_events';
const consent = { consentVersion: 'v1' as const };

describe.skipIf(!databaseUrl)('D2-R1 controlled onboarding-event erasure (real PostgreSQL)', () => {
  let admin: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  let service: CustomerMembershipService;
  const extra: Client[] = [];
  let seq = 0;

  const connect = async (): Promise<Client> => {
    const c = new Client({ connectionString: databaseUrl });
    await c.connect();
    extra.push(c);
    return c;
  };
  const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
  /** A fresh session acting as `role` (SET ROLE): an ordinary role is not a member of the erasure roles, the operator is. */
  const asRole = async <T>(role: string, fn: (c: Client) => Promise<T>): Promise<T> => {
    const c = await connect();
    try {
      await c.query(`SET ROLE ${role}`);
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const erase = (c: Client, business: string, customer: string, ref = `req-${run}-${++seq}`, severCashier = false) =>
    c.query(`SELECT * FROM ${FN}($1, $2, $3, $4)`, [business, customer, ref, severCashier]);
  const operatorErase = (business: string, customer: string, ref?: string, severCashier = false) =>
    asRole('d2r1_operator', (c) => erase(c, business, customer, ref, severCashier));

  interface World { biz: string; b1: string; b2: string; cashier: string }
  const world = async (label: string): Promise<World> => {
    const biz = (await repos.businesses.create({ name: `Erase ${label}`, slug: `er-${label}-${run}` })).id;
    const b1 = (await repos.branches.create({ businessId: biz, name: 'B1', slug: 'b1' })).id;
    const b2 = (await repos.branches.create({ businessId: biz, name: 'B2', slug: 'b2' })).id;
    const cashier = (await repos.users.create({ email: `er-cashier-${label}-${run}@example.test`, fullName: 'Cashier', passwordHash: 'x', status: 'active' })).id;
    const role = (await q(`INSERT INTO roles (business_id, name, is_system) VALUES ($1, 'Counter', false) RETURNING id`, [biz]))[0].id as string;
    await q(`INSERT INTO user_business_roles (user_id, business_id, branch_id, role_id) VALUES ($1, $2, $3, $4)`, [cashier, biz, b1, role]);
    return { biz, b1, b2, cashier };
  };
  let phoneSeq = 0;
  const customer = async (): Promise<{ id: string; phone: string }> => {
    const phone = `+1559${run.replace(/\D/g, '').padEnd(6, '3').slice(0, 5)}${String(++phoneSeq).padStart(3, '0')}`;
    return { id: (await repos.customers.create({ phone, phoneVerifiedAt: new Date() })).id, phone };
  };
  const joinQr = (w: World, customerId: string, branchId = w.b1, tx = service) =>
    tx.join({
      customerId, businessId: w.biz, onboardingSource: 'business_qr', onboardingReference: `qr-${run}-${++seq}`, ...consent,
      attribution: { source: 'business_qr', branchId, reference: `qr-${run}-${seq}` },
    });
  /** A cashier-assisted event written straight through the (unchanged) INSERT guard, with a chosen age. */
  const assistedEvent = async (w: World, customerId: string, ageMinutes: number, isRejoin = false): Promise<string> => {
    const membership = (await q(`SELECT id FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2`, [customerId, w.biz]))[0].id as string;
    const occurred = new Date(Date.now() - ageMinutes * 60_000);
    return (await q(
      `INSERT INTO customer_onboarding_events (membership_id, business_id, customer_id, branch_id, cashier_user_id, source, verification_state, reference, is_rejoin, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'cashier_assisted', 'unverified', $6, $7, $8) RETURNING id`,
      [membership, w.biz, customerId, w.b1, w.cashier, `inv-${run}-${++seq}`, isRejoin, occurred],
    ))[0].id as string;
  };
  const events = (biz: string, customerId?: string) =>
    q(`SELECT * FROM customer_onboarding_events WHERE business_id = $1 ${customerId ? 'AND customer_id = $2' : ''} ORDER BY occurred_at, id`, customerId ? [biz, customerId] : [biz]);
  const eventById = async (id: string) => (await q(`SELECT * FROM customer_onboarding_events WHERE id = $1`, [id]))[0];
  const waiters = async (key: string) =>
    Number((await q(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`, [key]))[0].n);
  const waitFor = async (key: string, n: number) => {
    for (let i = 0; i < 200; i++) {
      if ((await waiters(key)) >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the expected lock waiters never appeared');
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    db = buildDb(admin);
    repos = createRepositories(db);
    service = new CustomerMembershipService(db);
    // Ordinary roles for the denial tests (NOLOGIN; the SET ROLE is done by the superuser test connection). The "application" role has full
    // DML on every table, exactly what an application session has, and is not a member of any erasure role.
    for (const r of ['d2r1_app_sim', 'd2r1_operator']) {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
    }
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO d2r1_app_sim`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO d2r1_app_sim, d2r1_operator`);
    await admin.query(`GRANT onboarding_erasure_operator TO d2r1_operator`);
  });

  afterAll(async () => {
    for (const c of extra) await c.end().catch(() => undefined);
    await admin?.query(`REVOKE onboarding_erasure_operator FROM d2r1_operator`).catch(() => undefined);
    await admin?.end();
  });

  describe('schema, privileges and the unchanged append-only guarantee', () => {
    it('keeps the guard triggers ENABLE ALWAYS and the audit table append-only', async () => {
      const t = await q(`SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('customer_onboarding_events'::regclass, 'onboarding_erasure_operations'::regclass) ORDER BY tgname`);
      expect(t.map((r) => r.tgname)).toEqual(['customer_onboarding_event_guard_trg', 'customer_onboarding_events_no_truncate', 'onboarding_erasure_operation_guard_trg', 'onboarding_erasure_operations_no_truncate']);
      expect(t.every((r) => r.tgenabled === 'A')).toBe(true);
    });

    it('creates only NOLOGIN, non-superuser roles, and no one is a member of the owner role', async () => {
      const roles = await q(`SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname IN ('onboarding_erasure_owner','onboarding_erasure_operator') ORDER BY 1`);
      expect(roles).toHaveLength(2);
      for (const r of roles) expect([r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolbypassrls]).toEqual([false, false, false, false]);
      const members = await q(`SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = 'onboarding_erasure_owner'`);
      expect(members[0].n).toBe(0);
      expect((await q(`SELECT pg_has_role('d2r1_app_sim', 'onboarding_erasure_owner', 'MEMBER') AS m`))[0].m).toBe(false);
    });

    it('the function is SECURITY DEFINER, owned by the internal role, with a fixed search_path, executable only by the operator role', async () => {
      const f = (await q(`SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig FROM pg_proc WHERE proname = 'onboarding_erase_customer_events'`))[0];
      expect(f.owner).toBe('onboarding_erasure_owner');
      expect(f.prosecdef).toBe(true);
      expect(f.proconfig).toContain('search_path=pg_catalog, public');
      const sig = 'public.onboarding_erase_customer_events(uuid,uuid,text,boolean)';
      const priv = (role: string) => q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, sig]).then((r) => r[0].ok as boolean);
      expect(await priv('public')).toBe(false);
      expect(await priv('d2r1_app_sim')).toBe(false);
      expect(await priv('d2r1_operator')).toBe(true);
    });

    it('the erasure roles hold only the privileges they need (column-level UPDATE, no DELETE, no other table)', async () => {
      const col = (c: string) => q(`SELECT has_column_privilege('onboarding_erasure_owner', 'customer_onboarding_events', $1, 'UPDATE') AS ok`, [c]).then((r) => r[0].ok as boolean);
      for (const c of ['customer_id', 'membership_id', 'consent_grant_id', 'audit_log_id', 'reference', 'cashier_user_id', 'occurred_at', 'recorded_at', 'erased_at', 'erasure_operation_id']) expect(await col(c)).toBe(true);
      for (const c of ['business_id', 'branch_id', 'source', 'verification_state', 'is_rejoin', 'id']) expect(await col(c)).toBe(false);
      expect((await q(`SELECT has_table_privilege('onboarding_erasure_owner', 'customer_onboarding_events', 'DELETE') AS ok`))[0].ok).toBe(false);
      expect((await q(`SELECT has_table_privilege('onboarding_erasure_operator', 'customer_onboarding_events', 'SELECT') AS ok`))[0].ok).toBe(false);
      expect((await q(`SELECT has_table_privilege('onboarding_erasure_operator', 'onboarding_erasure_operations', 'INSERT') AS ok`))[0].ok).toBe(false);
      expect((await q(`SELECT has_table_privilege('public', 'onboarding_erasure_operations', 'SELECT') AS ok`))[0].ok).toBe(false);
    });

    it('ordinary UPDATE, DELETE and TRUNCATE are still refused, for the superuser and for an ordinary application role', async () => {
      const w = await world('append');
      const c = await customer();
      await joinQr(w, c.id);
      const [e] = await events(w.biz, c.id);
      for (const attempt of [
        `UPDATE customer_onboarding_events SET reference = 'x' WHERE id = '${e.id}'`,
        `UPDATE customer_onboarding_events SET customer_id = NULL WHERE id = '${e.id}'`,
        `DELETE FROM customer_onboarding_events WHERE id = '${e.id}'`,
        `TRUNCATE customer_onboarding_events`,
      ]) {
        await expect(admin.query(attempt)).rejects.toThrow(/ONBOARDING_EVENT_APPEND_ONLY|ONBOARDING_EVENT_TRUNCATE_DENIED/);
        await expect(asRole('d2r1_app_sim', (x) => x.query(attempt))).rejects.toThrow(/ONBOARDING_EVENT_APPEND_ONLY|ONBOARDING_EVENT_TRUNCATE_DENIED/);
      }
      expect((await eventById(e.id)).customer_id).toBe(c.id);
    });

    it('an erased state cannot be inserted, and a half-severed row is refused by the shape constraint', async () => {
      const w = await world('shape');
      const c = await customer();
      await joinQr(w, c.id);
      const [e] = await events(w.biz, c.id);
      await expect(q(
        `INSERT INTO customer_onboarding_events (membership_id, business_id, customer_id, source, verification_state, is_rejoin, occurred_at, erased_at)
         VALUES ($1, $2, $3, 'business_qr', 'unverified', false, now(), now())`, [e.membership_id, w.biz, c.id],
      )).rejects.toThrow(/ONBOARDING_EVENT_ERASED_STATE_NOT_INSERTABLE/);
      await expect(q(
        `INSERT INTO customer_onboarding_events (membership_id, business_id, customer_id, source, verification_state, is_rejoin, occurred_at)
         VALUES (NULL, $1, NULL, 'business_qr', 'unverified', false, now())`, [w.biz],
      )).rejects.toThrow(/ONBOARDING_EVENT_MEMBERSHIP_MISMATCH|erasure_shape_check/); // the INSERT guard refuses a link-less row before the constraint is reached
    });
  });

  describe('authorization boundary', () => {
    it('an ordinary application role, and any other role, cannot call the function or become the erasure owner', async () => {
      const w = await world('auth');
      const c = await customer();
      await joinQr(w, c.id);
      await expect(asRole('d2r1_app_sim', (x) => erase(x, w.biz, c.id))).rejects.toThrow(/permission denied for function/);
      expect((await q(`SELECT pg_has_role('d2r1_app_sim', 'onboarding_erasure_owner', 'USAGE') AS m`))[0].m).toBe(false);
      await expect(asRole('d2r1_app_sim', (x) => x.query(`UPDATE customer_onboarding_events SET customer_id = NULL`))).rejects.toThrow(/ONBOARDING_EVENT_APPEND_ONLY/);
      expect((await events(w.biz, c.id))).toHaveLength(1);
    });

    it('session variables, markers and forged identifiers do not open the exception', async () => {
      const w = await world('forge');
      const c = await customer();
      await joinQr(w, c.id);
      const [e] = await events(w.biz, c.id);
      const forged = `UPDATE customer_onboarding_events SET customer_id = NULL, membership_id = NULL, consent_grant_id = NULL, audit_log_id = NULL, reference = NULL,
        erased_at = now(), erasure_operation_id = '${randomUUID()}' WHERE id = '${e.id}'`;
      await expect(asRole('d2r1_app_sim', async (x) => {
        await x.query(`SET app.erasure_authorized = 'on'`);
        await x.query(`SET LOCAL echogrid.onboarding_erasure = 'on'`);
        await x.query(`SET session_replication_role = replica`).catch(() => undefined);
        return x.query(forged);
      })).rejects.toThrow(/ONBOARDING_EVENT_APPEND_ONLY/);
      // the superuser with the replica role (which skips ordinary triggers) is still stopped: the trigger is ENABLE ALWAYS
      await admin.query(`SET session_replication_role = replica`);
      try {
        await expect(admin.query(forged)).rejects.toThrow(/ONBOARDING_EVENT_APPEND_ONLY/);
      } finally {
        await admin.query(`RESET session_replication_role`);
      }
      expect((await eventById(e.id)).erased_at).toBeNull();
    });

    it('even the erasure role cannot do anything but the one transition (fields outside it cannot change)', async () => {
      const w = await world('shape2');
      const c = await customer();
      const other = await customer();
      await joinQr(w, c.id);
      await joinQr(w, other.id);
      const [e] = await events(w.biz, c.id);
      const ok = `customer_id = NULL, membership_id = NULL, consent_grant_id = NULL, audit_log_id = NULL, reference = NULL, erased_at = now(), erasure_operation_id = $1,
        occurred_at = date_trunc('day', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', recorded_at = date_trunc('day', recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
      const op = (await q(`INSERT INTO onboarding_erasure_operations (business_id, request_ref, operator_role, events_erased, events_deferred, residual_singletons, cashier_severed, outcome)
        VALUES ($1, $2, 'test', 1, 0, 0, false, 'completed') RETURNING id`, [w.biz, `forge-${run}-${++seq}`]))[0].id as string;
      const attempt = async (setClause: string, values: unknown[]) => {
        const c2 = await connect();
        try {
          await c2.query('SET ROLE onboarding_erasure_owner');
          await c2.query(`UPDATE customer_onboarding_events SET ${setClause} WHERE id = '${e.id}'`, values);
        } finally { await c2.end(); }
      };
      // a different branch, source, business, verification state or rejoin flag is refused (and is not even column-privileged)
      await expect(attempt(`${ok}, source = 'cashier_assisted'`, [op])).rejects.toThrow(/permission denied|ERASURE_TRANSITION_INVALID/);
      await expect(attempt(`${ok}, business_id = '${randomUUID()}'`, [op])).rejects.toThrow(/permission denied|ERASURE_TRANSITION_INVALID/);
      // an erasure operation recorded for a DIFFERENT business cannot be attached to this business's event (tenant-consistent audit link)
      const foreignBiz = (await repos.businesses.create({ name: 'Erase foreign', slug: `er-foreign-${run}-${++seq}` })).id;
      const foreignOp = (await q(`INSERT INTO onboarding_erasure_operations (business_id, request_ref, operator_role, events_erased, events_deferred, residual_singletons, cashier_severed, outcome)
        VALUES ($1, $2, 'test', 1, 0, 0, false, 'completed') RETURNING id`, [foreignBiz, `foreign-${run}-${seq}`]))[0].id as string;
      await expect(attempt(ok, [foreignOp])).rejects.toThrow(/ERASURE_TRANSITION_INVALID/);
      // re-pointing the customer link instead of severing it
      await expect(attempt(`customer_id = '${other.id}', membership_id = NULL, consent_grant_id = NULL, audit_log_id = NULL, reference = NULL, erased_at = now(), erasure_operation_id = $1,
        occurred_at = date_trunc('day', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', recorded_at = date_trunc('day', recorded_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [op])).rejects.toThrow(/ERASURE_TRANSITION_INVALID/);
      // keeping precise timestamps, or a partial sever, or no erasure marker
      await expect(attempt(`customer_id = NULL, membership_id = NULL, consent_grant_id = NULL, audit_log_id = NULL, reference = NULL, erased_at = now(), erasure_operation_id = $1`, [op])).rejects.toThrow(/ERASURE_TRANSITION_INVALID/);
      await expect(attempt(`customer_id = NULL, erased_at = now(), erasure_operation_id = $1`, [op])).rejects.toThrow(/ERASURE_TRANSITION_INVALID|erasure_shape_check/);
      await expect(attempt(`customer_id = NULL, membership_id = NULL, consent_grant_id = NULL, audit_log_id = NULL, reference = NULL`, [])).rejects.toThrow(/ERASURE_TRANSITION_INVALID/);
      // the sanctioned shape itself works for the role, once; a second transition on the same row is refused
      await attempt(ok, [op]);
      await expect(attempt(ok, [op])).rejects.toThrow(/ERASURE_TRANSITION_INVALID/);
      expect((await eventById(e.id)).erased_at).not.toBeNull();
      expect((await events(w.biz, other.id))[0].customer_id).toBe(other.id);
    });
  });

  describe('the erasure operation', () => {
    it('severs every personal link of ONE customer in ONE business, keeps the non-identifying attributes, and writes a minimal audit row', async () => {
      const w = await world('main');
      const w2 = await world('main2');
      const c = await customer();
      const bystander = await customer();
      await joinQr(w, c.id, w.b1);
      await joinQr(w, bystander.id, w.b1);
      await joinQr(w2, c.id, w2.b2); // the same person in another business
      const before = (await events(w.biz, c.id))[0];
      const bystanderBefore = (await events(w.biz, bystander.id))[0];
      const otherBizBefore = (await events(w2.biz, c.id))[0];
      const ref = `dsr-${run}-main`;
      const r = await operatorErase(w.biz, c.id, ref);
      expect(r.rows[0]).toMatchObject({ out_events_erased: 1, out_events_deferred: 0, out_outcome: 'completed' });
      const after = await eventById(before.id);
      expect(after).toMatchObject({ customer_id: null, membership_id: null, consent_grant_id: null, audit_log_id: null, reference: null });
      expect(after.erased_at).not.toBeNull();
      expect(after.erasure_operation_id).toBe(r.rows[0].out_operation_id);
      // retained: identity of the row, tenant, branch, source, verification state, rejoin flag; times generalized to the UTC day
      expect([after.id, after.business_id, after.branch_id, after.source, after.verification_state, after.is_rejoin]).toEqual([before.id, before.business_id, before.branch_id, before.source, before.verification_state, before.is_rejoin]);
      const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      expect(after.occurred_at.getTime()).toBe(day(before.occurred_at));
      expect(after.recorded_at.getTime()).toBe(day(before.recorded_at));
      // other customers and the same customer in another business are untouched
      expect(await eventById(bystanderBefore.id)).toEqual(bystanderBefore);
      expect(await eventById(otherBizBefore.id)).toEqual(otherBizBefore);
      // the audit row: counts and the operator's database login, no customer, membership, consent or contact detail
      const audit = (await q(`SELECT * FROM onboarding_erasure_operations WHERE id = $1`, [r.rows[0].out_operation_id]))[0];
      expect(audit).toMatchObject({ business_id: w.biz, request_ref: ref, events_erased: 1, events_deferred: 0, cashier_severed: false, outcome: 'completed' });
      expect(audit.operator_role).toBe(String((await q(`SELECT session_user AS u`))[0].u));
      const dump = JSON.stringify([audit, after]);
      for (const secret of [c.id, c.phone, before.membership_id, before.consent_grant_id, before.audit_log_id, before.reference]) if (secret) expect(dump).not.toContain(secret);
    });

    it('leaves the membership, consent, loyalty account and transactions exactly as they were', async () => {
      const w = await world('loyalty');
      const c = await customer();
      const joined = await joinQr(w, c.id);
      await q(`INSERT INTO loyalty_transactions (loyalty_account_id, type, points) VALUES ($1, 'adjustment', 5)`, [joined.loyaltyAccount.id]);
      const snapshot = async () => ({
        m: await q(`SELECT * FROM business_customer_memberships WHERE customer_id = $1`, [c.id]),
        a: await q(`SELECT * FROM loyalty_accounts WHERE customer_id = $1`, [c.id]),
        t: await q(`SELECT id, points, type FROM loyalty_transactions WHERE loyalty_account_id = $1 ORDER BY id`, [joined.loyaltyAccount.id]),
        g: await q(`SELECT * FROM consent_grants WHERE customer_id = $1 AND business_id = $2`, [c.id, w.biz]),
      });
      const before = await snapshot();
      await operatorErase(w.biz, c.id);
      expect(await snapshot()).toEqual(before);
    });

    it('is idempotent: a repeat changes nothing and is recorded as a no-op', async () => {
      const w = await world('idem');
      const c = await customer();
      await joinQr(w, c.id);
      const first = await operatorErase(w.biz, c.id);
      const snapshot = await events(w.biz, c.id).catch(() => []);
      expect(snapshot).toEqual([]); // no longer selectable by customer id
      const erasedRows = await q(`SELECT * FROM customer_onboarding_events WHERE erasure_operation_id = $1`, [first.rows[0].out_operation_id]);
      const second = await operatorErase(w.biz, c.id);
      expect(second.rows[0]).toMatchObject({ out_events_erased: 0, out_events_deferred: 0, out_outcome: 'noop' });
      expect(await q(`SELECT * FROM customer_onboarding_events WHERE erasure_operation_id = $1`, [first.rows[0].out_operation_id])).toEqual(erasedRows);
      expect((await q(`SELECT count(*)::int AS n FROM onboarding_erasure_operations WHERE business_id = $1`, [w.biz]))[0].n).toBe(2);
    });

    it('cross-business scope: the wrong business erases nothing; an unknown customer erases nothing', async () => {
      const w = await world('scopeA');
      const w2 = await world('scopeB');
      const c = await customer();
      await joinQr(w, c.id);
      expect((await operatorErase(w2.biz, c.id)).rows[0]).toMatchObject({ out_events_erased: 0, out_outcome: 'noop' });
      expect((await operatorErase(w.biz, randomUUID())).rows[0]).toMatchObject({ out_events_erased: 0, out_outcome: 'noop' });
      expect((await events(w.biz, c.id))[0].erased_at).toBeNull();
    });

    it('rejects a missing scope and an unsafe request reference (no free text, no contact detail)', async () => {
      const w = await world('args');
      const c = await customer();
      await joinQr(w, c.id);
      await asRole('d2r1_operator', async (x) => {
        await expect(x.query(`SELECT * FROM ${FN}(NULL, $1, 'r1', false)`, [c.id])).rejects.toThrow(/ONBOARDING_ERASURE_SCOPE_REQUIRED/);
        await expect(x.query(`SELECT * FROM ${FN}($1, NULL, 'r1', false)`, [w.biz])).rejects.toThrow(/ONBOARDING_ERASURE_SCOPE_REQUIRED/);
        await expect(x.query(`SELECT * FROM ${FN}($1, $2, 'r1', NULL)`, [w.biz, c.id])).rejects.toThrow(/ONBOARDING_ERASURE_SCOPE_REQUIRED/);
        for (const bad of ['', 'a b', 'person@example.test', 'x'.repeat(65), "r1'; DROP TABLE x;--"]) {
          await expect(x.query(`SELECT * FROM ${FN}($1, $2, $3, false)`, [w.biz, c.id, bad])).rejects.toThrow(/ONBOARDING_ERASURE_REQUEST_REF_INVALID/);
        }
      });
      expect((await events(w.biz, c.id))[0].erased_at).toBeNull();
    });

    it('is not fooled by a hostile search_path', async () => {
      const w = await world('path');
      const c = await customer();
      await joinQr(w, c.id);
      await admin.query(`CREATE SCHEMA IF NOT EXISTS d2r1_evil`);
      await admin.query(`CREATE TABLE IF NOT EXISTS d2r1_evil.customer_onboarding_events (id uuid, business_id uuid, customer_id uuid, erased_at timestamptz)`);
      await admin.query(`GRANT USAGE ON SCHEMA d2r1_evil TO d2r1_operator`);
      const r = await asRole('d2r1_operator', async (x) => {
        await x.query(`SET search_path = d2r1_evil, public`);
        return erase(x, w.biz, c.id);
      });
      expect(r.rows[0].out_events_erased).toBe(1);
      expect((await q(`SELECT count(*)::int AS n FROM d2r1_evil.customer_onboarding_events`))[0].n).toBe(0);
      await admin.query(`DROP SCHEMA d2r1_evil CASCADE`);
    });

    it('rolls back atomically on an injected failure: nothing erased, no audit row, and a clean retry works', async () => {
      const w = await world('fail');
      const c = await customer();
      await joinQr(w, c.id, w.b1);
      const second = await customer();
      await joinQr(w, second.id, w.b1);
      const mine = await events(w.biz, c.id);
      await admin.query(`CREATE OR REPLACE FUNCTION d2r1_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'D2R1_INJECTED_FAILURE'; END $$`);
      await admin.query(`CREATE TRIGGER a0_d2r1_fail BEFORE UPDATE ON customer_onboarding_events FOR EACH ROW WHEN (OLD.id = '${mine[0].id}') EXECUTE FUNCTION d2r1_inject_failure()`);
      const ref = `fail-${run}`;
      try {
        await expect(operatorErase(w.biz, c.id, ref)).rejects.toThrow(/D2R1_INJECTED_FAILURE/);
      } finally {
        await admin.query(`DROP TRIGGER a0_d2r1_fail ON customer_onboarding_events`);
        await admin.query(`DROP FUNCTION d2r1_inject_failure()`);
      }
      expect((await events(w.biz, c.id)).every((e) => e.erased_at === null)).toBe(true);
      expect((await q(`SELECT count(*)::int AS n FROM onboarding_erasure_operations WHERE request_ref = $1`, [ref]))[0].n).toBe(0);
      expect((await operatorErase(w.biz, c.id, `retry-${run}`)).rows[0].out_events_erased).toBe(1);
    });
  });

  describe('cashier attribution and invitation references (policy default only; R3 stays an Owner decision)', () => {
    it('keeps the cashier link by default, severs it only when the operator says so, and never leaves an invitation id behind', async () => {
      const w = await world('cashier');
      const keep = await customer();
      const sever = await customer();
      await joinQr(w, keep.id);
      await joinQr(w, sever.id);
      const e1 = await assistedEvent(w, keep.id, 60);
      const e2 = await assistedEvent(w, sever.id, 60);
      const r1 = await operatorErase(w.biz, keep.id);
      const r2 = await operatorErase(w.biz, sever.id, undefined, true);
      expect(r1.rows[0].out_events_erased).toBe(2);
      expect(r2.rows[0].out_events_erased).toBe(2);
      const kept = await eventById(e1);
      const severed = await eventById(e2);
      expect(kept.cashier_user_id).toBe(w.cashier);
      expect(severed.cashier_user_id).toBeNull();
      expect([kept.reference, severed.reference]).toEqual([null, null]);
      expect((await q(`SELECT cashier_severed FROM onboarding_erasure_operations WHERE id = $1`, [r2.rows[0].out_operation_id]))[0].cashier_severed).toBe(true);
    });

    it('defers an assisted event younger than the invitation lifetime so a still-valid invitation cannot be replayed', async () => {
      expect(ONBOARDING_INVITE_TTL_SECONDS).toBeLessThan(15 * 60); // the function waits 15 minutes: a 10-minute invitation is long expired
      const w = await world('defer');
      const c = await customer();
      await joinQr(w, c.id);
      const fresh = await assistedEvent(w, c.id, 1);
      const old = await assistedEvent(w, c.id, 60);
      const r = await operatorErase(w.biz, c.id);
      expect(r.rows[0]).toMatchObject({ out_events_erased: 2, out_events_deferred: 1, out_outcome: 'partial' });
      const freshRow = await eventById(fresh);
      expect(freshRow.erased_at).toBeNull();
      expect(freshRow.reference).not.toBeNull();
      expect((await eventById(old)).erased_at).not.toBeNull();
      expect(await repos.customerOnboardingEvents.assistedInviteUsed(w.biz, freshRow.reference as string)).toBe(true);
    });
  });

  describe('concurrency with the membership lifecycle', () => {
    it('two concurrent erasures: exactly one does the work, the other is a no-op, and nothing is erased twice', async () => {
      const w = await world('conc');
      const c = await customer();
      await joinQr(w, c.id, w.b1);
      await assistedEvent(w, c.id, 60);
      await assistedEvent(w, c.id, 61);
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => operatorErase(w.biz, c.id, `conc-${run}-${i}`)));
      const erased = results.map((r) => Number(r.rows[0].out_events_erased));
      expect(erased.reduce((a, b) => a + b, 0)).toBe(3);
      expect(erased.filter((n) => n === 3)).toHaveLength(1);
      const rows = await q(`SELECT erasure_operation_id, count(*)::int AS n FROM customer_onboarding_events WHERE business_id = $1 GROUP BY 1`, [w.biz]);
      expect(rows).toHaveLength(1);
      expect(rows[0].n).toBe(3);
    });

    const keyOf = (c: string, b: string) => `customer_business_relationship:${c}:${b}`;

    it('a join that already holds the relationship lock commits first: the erasure then sees and severs its event', async () => {
      const w = await world('race1');
      const c = await customer();
      const holder = await connect();
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keyOf(c.id, w.biz)]);
      const joinClient = await connect();
      const joiner = new CustomerMembershipService(buildDb(joinClient));
      const joinP = joinQr(w, c.id, w.b1, joiner);
      await waitFor(keyOf(c.id, w.biz), 1);
      const eraseP = operatorErase(w.biz, c.id);
      await waitFor(keyOf(c.id, w.biz), 2);
      await holder.query('COMMIT');
      await joinP;
      const r = await eraseP;
      expect(r.rows[0].out_events_erased).toBe(1);
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE business_id = $1 AND erased_at IS NOT NULL`, [w.biz]))[0].n).toBe(1);
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE business_id = $1 AND customer_id = $2`, [w.biz, c.id]))[0].n).toBe(0);
    });

    it('an erasure that runs first, then a re-join: the old event stays erased and the new one is a normal, fully linked event (no resurrection)', async () => {
      const w = await world('race2');
      const c = await customer();
      await joinQr(w, c.id, w.b1);
      await service.leave(c.id, w.biz);
      const holder = await connect();
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keyOf(c.id, w.biz)]);
      const eraseP = operatorErase(w.biz, c.id);
      await waitFor(keyOf(c.id, w.biz), 1);
      const joinClient = await connect();
      const joinP = joinQr(w, c.id, w.b2, new CustomerMembershipService(buildDb(joinClient)));
      await waitFor(keyOf(c.id, w.biz), 2);
      await holder.query('COMMIT');
      expect((await eraseP).rows[0].out_events_erased).toBe(1);
      await joinP;
      const all = await q(`SELECT * FROM customer_onboarding_events WHERE business_id = $1 ORDER BY recorded_at, id`, [w.biz]);
      expect(all).toHaveLength(2);
      expect(all.filter((e) => e.erased_at !== null)).toHaveLength(1);
      const fresh = all.find((e) => e.erased_at === null);
      expect(fresh).toMatchObject({ customer_id: c.id, is_rejoin: true, branch_id: w.b2 });
      expect((await q(`SELECT status FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2`, [c.id, w.biz]))[0].status).toBe('active');
      // erasing again severs the new event as well, and the old one is not touched twice
      expect((await operatorErase(w.biz, c.id)).rows[0].out_events_erased).toBe(1);
    });

    it('leave and erasure racing: both succeed, the membership ends, every event is whole (fully linked or fully severed), no loyalty row lost', async () => {
      for (let round = 0; round < 8; round++) {
        const w = await world(`leave${round}`);
        const c = await customer();
        const joined = await joinQr(w, c.id);
        const leaveClient = await connect();
        const [, r] = await Promise.all([new CustomerMembershipService(buildDb(leaveClient)).leave(c.id, w.biz), operatorErase(w.biz, c.id)]);
        expect(r.rows[0].out_events_erased).toBe(1);
        expect((await q(`SELECT status FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2`, [c.id, w.biz]))[0].status).toBe('left');
        expect((await q(`SELECT count(*)::int AS n FROM loyalty_accounts WHERE id = $1`, [joined.loyaltyAccount.id]))[0].n).toBe(1);
        const e = (await events(w.biz)).every((x) => (x.erased_at === null) === (x.customer_id !== null));
        expect(e).toBe(true);
      }
    });

    it('consent withdrawal and erasure racing leave a consistent state', async () => {
      const w = await world('consentrace');
      const c = await customer();
      await joinQr(w, c.id);
      const wClient = await connect();
      const withdraw = async () => {
        const wdb = buildDb(wClient);
        const { ConsentWithdrawalService } = await import('../../src/consent/consent-withdrawal.service');
        const svc = new ConsentWithdrawalService(wdb);
        const grant = (await q(`SELECT id FROM consent_grants WHERE customer_id = $1 AND business_id = $2 AND purpose = 'join_loyalty'`, [c.id, w.biz]))[0].id as string;
        return (svc as unknown as { withdraw: (customerId: string, consentId: string) => Promise<unknown> }).withdraw(c.id, grant);
      };
      const [, r] = await Promise.all([withdraw().catch((e: unknown) => e), operatorErase(w.biz, c.id)]);
      expect(r.rows[0].out_events_erased).toBe(1);
      const rows = await events(w.biz);
      expect(rows.every((x) => (x.erased_at === null) === (x.customer_id !== null))).toBe(true);
    });
  });

  describe('reporting and re-identification', () => {
    it('keeps event, branch, source and rejoin totals; distinct customers exclude erased events and the erased count says so; nothing is invented', async () => {
      const w = await world('report');
      const a = await customer();
      const b = await customer();
      await joinQr(w, a.id, w.b1);
      await joinQr(w, b.id, w.b2);
      await assistedEvent(w, a.id, 60, true);
      const before = await repos.customerOnboardingEvents.summarize({ businessId: w.biz });
      expect(before.totals).toMatchObject({ events: 3, uniqueCustomers: 2, erasedEvents: 0, rejoinEvents: 1 });
      await operatorErase(w.biz, a.id);
      const after = await repos.customerOnboardingEvents.summarize({ businessId: w.biz });
      expect(after.totals).toMatchObject({ events: 3, uniqueCustomers: 1, erasedEvents: 2, rejoinEvents: 1 });
      expect(after.bySource.map((s) => [s.source, s.events])).toEqual(before.bySource.map((s) => [s.source, s.events]));
      expect(after.byBranch.map((x) => [x.branchId, x.events])).toEqual(before.byBranch.map((x) => [x.branchId, x.events]));
      expect(after.byCashier.map((x) => [x.cashierUserId, x.events])).toEqual([[w.cashier, 1]]); // cashier retained by default
      await operatorErase(w.biz, b.id, undefined, true);
      const sevenCashier = await customer();
      await joinQr(w, sevenCashier.id, w.b1);
      await assistedEvent(w, sevenCashier.id, 60);
      await operatorErase(w.biz, sevenCashier.id, undefined, true);
      const last = await repos.customerOnboardingEvents.summarize({ businessId: w.biz });
      expect(last.byCashier.map((x) => x.events)).toEqual([1]); // a severed assisted event no longer appears per cashier, yet stays in the totals
      expect(last.totals.events).toBe(5);
    });

    it('flags erased events that are unique by their remaining attributes (small businesses) instead of assuming day-level times are enough', async () => {
      const w = await world('singleton');
      const [c1, c2, c3] = [await customer(), await customer(), await customer()];
      for (const c of [c1, c2, c3]) await joinQr(w, c.id, w.b1);
      const r1 = await operatorErase(w.biz, c1.id); // alone in its (branch, source, day, verification, rejoin) group at that moment
      expect(r1.rows[0].out_residual_singletons).toBe(1);
      const r2 = await operatorErase(w.biz, c2.id);
      expect(r2.rows[0].out_residual_singletons).toBe(0);
      const lone = await world('singleton2');
      const c = await customer();
      await joinQr(lone, c.id, lone.b2);
      expect((await operatorErase(lone.biz, c.id)).rows[0].out_residual_singletons).toBe(1);
    });

    it('no column of an erased event or of the audit table can recover the customer', async () => {
      const w = await world('resid');
      const c = await customer();
      const joined = await joinQr(w, c.id);
      const before = (await events(w.biz, c.id))[0];
      await operatorErase(w.biz, c.id);
      const row = JSON.stringify(await eventById(before.id));
      const audits = JSON.stringify(await q(`SELECT * FROM onboarding_erasure_operations WHERE business_id = $1`, [w.biz]));
      for (const secret of [c.id, c.phone, joined.membership.id, before.consent_grant_id, before.reference]) {
        expect(row).not.toContain(String(secret));
        expect(audits).not.toContain(String(secret));
      }
    });
  });

  describe('residual linkage through audit_log (characterization of a KNOWN limitation; R6 and the audit governance decision are open)', () => {
    // These tests document what erasure does NOT remove. They assert the CURRENT residual so that the limitation cannot be forgotten
    // or silently widened; if audit metadata is ever minimized under an approved policy, they must be updated deliberately.
    it('an erased event is still joined to its immutable customer.onboarded audit row by id, and that row names the membership and the exact time', async () => {
      const w = await world('auditlink');
      const c = await customer();
      const { membership } = await joinQr(w, c.id, w.b1);
      const eventId = (await events(w.biz, c.id))[0].id as string;
      await operatorErase(w.biz, c.id);

      const erased = await eventById(eventId);
      expect(erased.customer_id).toBeNull();
      expect(erased.membership_id).toBeNull();
      expect(erased.audit_log_id).toBeNull(); // the event's own pointer IS severed ...

      // ... but the audit row points at the event (entity_id = event id) and carries the membership id and the exact creation time
      const audit = (await q(`SELECT * FROM audit_log WHERE entity_type = 'customer_onboarding_event' AND entity_id = $1`, [eventId]))[0];
      expect(audit).toBeDefined();
      expect(audit.action).toBe('customer.onboarded');
      expect(audit.metadata.membershipId).toBe(membership.id);
      const exact = (await q(`SELECT created_at <> date_trunc('day', created_at) AS exact FROM audit_log WHERE id = $1`, [audit.id]))[0];
      expect(exact.exact).toBe(true); // sub-day precision survives in the audit table

      // and the membership still resolves to the customer, so event-level anonymization alone does not prevent re-identification
      const back = (await q(`SELECT customer_id FROM business_customer_memberships WHERE id = $1`, [audit.metadata.membershipId]))[0];
      expect(back.customer_id).toBe(c.id);
    });

    it('even WITHOUT membershipId, the audit row re-identifies the customer by timing: its exact time matches the membership row that still exists (so removing the field alone would not anonymize)', async () => {
      const w = await world('timing');
      const c = await customer();
      await joinQr(w, c.id, w.b1);
      const eventId = (await events(w.biz, c.id))[0].id as string;
      await operatorErase(w.biz, c.id);
      const audit = (await q(`SELECT id, created_at FROM audit_log WHERE entity_type = 'customer_onboarding_event' AND entity_id = $1`, [eventId]))[0];
      const matches = await q(
        `SELECT customer_id FROM business_customer_memberships WHERE business_id = $1 AND abs(extract(epoch FROM (joined_at - $2::timestamptz))) < 1`, [w.biz, audit.created_at]);
      expect(matches).toEqual([{ customer_id: c.id }]); // a single membership joined at that moment: the timing correlation alone identifies the customer
    });

    it('the erasure roles can read neither audit_log, memberships nor customers; audit_log is now guarded by the 0085 immutability triggers, which do NOT redact or unlink anything', async () => {
      for (const role of ['onboarding_erasure_operator', 'onboarding_erasure_owner']) {
        for (const table of ['audit_log', 'business_customer_memberships', 'customers']) {
          expect(await q(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, table])).toEqual([{ ok: false }]);
        }
      }
      // D2-R8 (migration 0085) made audit_log database-immutable. That PROTECTS the audit row (including the linkage above) from change; it does
      // not minimize it. The re-identification path therefore remains until a separately approved minimization exists (R8-B, R6, R7).
      expect((await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass AND NOT tgisinternal ORDER BY tgname`)).map((r) => r.tgname))
        .toEqual(['audit_log_immutability_guard_trg', 'audit_log_no_truncate']);
    });
  });

  describe('the audit table', () => {
    it('is append-only and holds counts, never identifiers', async () => {
      const w = await world('audit');
      const c = await customer();
      await joinQr(w, c.id);
      const r = await operatorErase(w.biz, c.id);
      const id = r.rows[0].out_operation_id as string;
      await expect(admin.query(`UPDATE onboarding_erasure_operations SET events_erased = 9 WHERE id = $1`, [id])).rejects.toThrow(/ONBOARDING_ERASURE_AUDIT_APPEND_ONLY/);
      await expect(admin.query(`DELETE FROM onboarding_erasure_operations WHERE id = $1`, [id])).rejects.toThrow(/ONBOARDING_ERASURE_AUDIT_APPEND_ONLY/);
      await expect(admin.query(`TRUNCATE onboarding_erasure_operations`)).rejects.toThrow(/ONBOARDING_ERASURE_AUDIT_APPEND_ONLY|cannot truncate a table referenced in a foreign key constraint/);
      const columns = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'onboarding_erasure_operations' ORDER BY ordinal_position`)).map((x) => x.column_name);
      expect(columns).toEqual(['id', 'business_id', 'request_ref', 'operator_role', 'events_erased', 'events_deferred', 'residual_singletons', 'cashier_severed', 'outcome', 'created_at']);
    });
  });
});
