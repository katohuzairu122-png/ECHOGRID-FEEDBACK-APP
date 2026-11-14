import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { filterFor } from '../../src/cashier-activity/categories';

/** CASHIER-PWA-01 C7 on a SCRATCH database (DATABASE_URL, never production): scope, isolation, filters and keyset pagination. */
describe.skipIf(!process.env.DATABASE_URL)('cashier activity query (integration, scratch database)', () => {
  let c: Client;
  let repos: ReturnType<typeof createRepositories>;
  let user: string;
  let bizA: string;
  let bizB: string;
  const BR1 = randomUUID();
  const BR2 = randomUUID();

  const put = async (over: { business?: string; action: string; meta?: Record<string, unknown> | null; at?: string; id?: string }) => {
    const id = over.id ?? randomUUID();
    await c.query(
      `insert into audit_log (id, business_id, actor_user_id, action, entity_type, metadata, created_at) values ($1,$2,$3,$4,'x',$5,$6::timestamptz)`,
      [id, over.business ?? bizA, user, over.action, over.meta === undefined ? null : JSON.stringify(over.meta), over.at ?? new Date().toISOString()],
    );
    return id;
  };
  const list = (o: Partial<Parameters<typeof repos.auditLog.listCashierActivity>[0]> = {}) =>
    repos.auditLog.listCashierActivity({ businessId: bizA, branchIds: null, limit: 50, ...o });

  beforeAll(async () => {
    c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    repos = createRepositories(buildDb(c as never));
    user = (await c.query(`insert into users (email, password_hash, full_name) values ($1,'x','Pat') returning id`, [`c7-${randomUUID()}@example.test`])).rows[0].id;
    bizA = (await c.query(`insert into businesses (name, slug) values ('A',$1) returning id`, [`a-${randomUUID()}`])).rows[0].id;
    bizB = (await c.query(`insert into businesses (name, slug) values ('B',$1) returning id`, [`b-${randomUUID()}`])).rows[0].id;
  });
  afterAll(async () => {
    await c?.end();
  });

  it('selects only cashier-marked rows and cashier session actions, of the named business', async () => {
    const mark = (b: string) => ({ client: 'cashier', branchId: b, outcome: 'success' });
    const a1 = await put({ action: 'loyalty.purchase_recorded', meta: mark(BR1) });
    const sess = await put({ action: 'cashier_session.revoked', meta: { branchId: BR1 } });
    const web = await put({ action: 'loyalty.purchase_recorded', meta: { outcome: 'success' } }); // staff-app row
    const other = await put({ business: bizB, action: 'loyalty.purchase_recorded', meta: mark(BR1) });
    const unrelated = await put({ action: 'team.invite', meta: mark(BR1) });
    const ids = (await list()).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([a1, sess]));
    for (const excluded of [web, other, unrelated]) expect(ids).not.toContain(excluded);
    expect((await list()).every((r) => r.businessId === bizA && r.actorFullName === 'Pat')).toBe(true);
  });

  it('branch scope: only authorized branches; business-level rows stay business-wide only', async () => {
    const r1 = await put({ action: 'loyalty.customer_lookup', meta: { client: 'cashier', branchId: BR1 } });
    const r2 = await put({ action: 'loyalty.customer_lookup', meta: { client: 'cashier', branchId: BR2 } });
    const none = await put({ action: 'cashier_session.revoked_all', meta: { revoked: 2 } });
    const m1 = (await list({ branchIds: [BR1] })).map((r) => r.id);
    expect(m1).toContain(r1);
    expect(m1).not.toContain(r2);
    expect(m1).not.toContain(none);
    expect(await list({ branchIds: [] })).toEqual([]);
    expect((await list({ branchIds: null })).map((r) => r.id)).toEqual(expect.arrayContaining([r1, r2, none]));
    // An explicit branch filter narrows further, and cannot widen a scoped caller.
    expect((await list({ branchIds: null, branchId: BR2 })).map((r) => r.id)).toEqual(expect.arrayContaining([r2]));
    expect((await list({ branchIds: [BR1], branchId: BR2 }))).toEqual([]);
  });

  it('category filters, including outcome-qualified redemption failures', async () => {
    const ok = await put({ action: 'cashier.redemption_lookup', meta: { client: 'cashier', outcome: 'success' } });
    const failed = await put({ action: 'cashier.redemption_lookup', meta: { client: 'cashier', outcome: 'failure' } });
    const rejected = await put({ action: 'cashier.redemption_rejected', meta: { client: 'cashier', outcome: 'failure' } });
    const done = await put({ action: 'loyalty.redemption_confirmed', meta: { client: 'cashier', outcome: 'success' } });
    const failure = (await list({ selection: filterFor('redemption_failure') })).map((r) => r.id);
    expect(failure).toEqual(expect.arrayContaining([failed, rejected]));
    expect(failure).not.toContain(ok);
    expect(failure).not.toContain(done);
    const success = (await list({ selection: filterFor('redemption_success') })).map((r) => r.id);
    expect(success).toContain(done);
    expect(success).not.toContain(rejected);
    const attempts = (await list({ selection: filterFor('redemption_attempt') })).map((r) => r.id);
    expect(attempts).toEqual(expect.arrayContaining([ok, failed, rejected, done]));
  });

  it('keyset pagination is deterministic, complete and duplicate-free across ties and sub-millisecond timestamps', async () => {
    const biz = (await c.query(`insert into businesses (name, slug) values ('P',$1) returning id`, [`p-${randomUUID()}`])).rows[0].id as string;
    const pfx = randomUUID().slice(0, 8); // fresh ids per run (re-runnable), same prefix so their relative order is fixed
    const mk = (n: number) => `${pfx}-0000-4000-8000-${String(n).padStart(12, '0')}`;
    // Five rows sharing one millisecond (different microseconds) and three more at other times.
    const base = '2026-03-01T10:00:00.123';
    const inserted: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = mk(i + 1);
      await c.query(`insert into audit_log (id, business_id, actor_user_id, action, entity_type, metadata, created_at) values ($1,$2,$3,'loyalty.customer_lookup','x','{"client":"cashier"}', $4::timestamptz)`, [id, biz, user, `${base}${400 + i * 100}+00`]);
      inserted.push(id);
    }
    for (let i = 0; i < 3; i++) {
      const id = mk(100 + i);
      await c.query(`insert into audit_log (id, business_id, actor_user_id, action, entity_type, metadata, created_at) values ($1,$2,$3,'loyalty.customer_lookup','x','{"client":"cashier"}', $4::timestamptz)`, [id, biz, user, `2026-03-0${2 + i}T09:00:00Z`]);
      inserted.push(id);
    }
    const seen: string[] = [];
    let before: { createdAt: Date; id: string } | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const rows = await repos.auditLog.listCashierActivity({ businessId: biz, branchIds: null, limit: 3, before });
      const page = rows.slice(0, 3);
      seen.push(...page.map((r) => r.id));
      if (rows.length <= 3) break;
      const last = page[page.length - 1]!;
      before = { createdAt: last.createdAt, id: last.id };
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect([...seen].sort()).toEqual([...inserted].sort());
    // Newest first; within one millisecond the id breaks the tie, descending.
    expect(seen.slice(0, 3)).toEqual([mk(102), mk(101), mk(100)]);
    expect(seen.slice(3)).toEqual([mk(5), mk(4), mk(3), mk(2), mk(1)]);
  });
});
