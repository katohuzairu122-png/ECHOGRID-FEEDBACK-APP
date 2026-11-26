import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Bindings } from '../../src/config/env';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { errorHandler } from '../../src/lib/error-handler';
import { auditTrail } from '../../src/middleware/audit';
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { platformDropsRoutes } from '../../src/platform/drops.routes';
import { signAccessToken } from '../../src/auth/jwt';
import { hashSpec, parseQualificationSpec } from '../../src/qualification/qualification-spec';

/**
 * TDP-02 against real PostgreSQL: independent review, atomic inventory, eligibility on the shared engine, state machines, tenant isolation, evidence chain. Synthetic data only; the
 * approved rule exists ONLY in this disposable test database.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const SECRET = 'shuffle-fixture-access-secret';
const run = randomUUID();
const tag = run.replace(/[0-9-]/g, (d) => 'abcdefghijk'[d.charCodeAt(0) % 11] as string);
const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/platform/drops', platformDropsRoutes);
app.onError(errorHandler);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
async function http(method: string, path: string, o: { token?: string; body?: unknown; flag?: string | undefined } = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined && method !== 'GET') headers.set('Content-Type', 'application/json');
  const env = { HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, TENTASHIP_DROPS_ENABLED: o.flag } as unknown as Bindings;
  const res = await app.request(`/api/v1/platform/drops${path}`, { method, headers, ...(o.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(o.body) }) }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text();
  let parsed: Envelope = {};
  try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* plain-text 404 */ }
  return { status: res.status, ...parsed };
}



describe.skipIf(!databaseUrl)('TDP-02 Drops sponsorship and atomic inventory (real HTTP, real PostgreSQL)', () => {
  let client: Client; let repos: ReturnType<typeof createRepositories>; let creatorId: string; let reviewerId: string; let creator: string; let reviewer: string; let plainToken: string;
  let bizA: string; let bizB: string; let approved: string;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const ON = 'true'; let seq = 0;
  const key = () => `dp_${tag}_${++seq}`.toLowerCase().slice(0, 60);
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  const ACK = { syntheticAcknowledged: true };
  const as = (token: string, method: string, path: string, body?: unknown) => http(method, path, { token, flag: ON, body });
  const draft = async (over: Record<string, unknown> = {}, biz = bizA) => {
    const r = await as(creator, 'POST', '/sponsorships', { ...ACK, key: key(), businessId: biz, productName: 'Synthetic item', description: 'A synthetic, non-commercial test unit.', quantityTotal: 3, collectionMethod: 'In person', collectionLocation: 'Synthetic counter',
      collectionWindowStart: iso(-3_600_000), collectionWindowEnd: iso(86_400_000), offerExpiresAt: iso(86_400_000), qualificationRuleVersionId: approved, ...over });
    expect(r.status, JSON.stringify(r)).toBe(201); return r.data.id as string;
  };
  const op = (id: string, path: string, token = reviewer, extra: Record<string, unknown> = {}) => as(token, 'POST', `/sponsorships/${id}/${path}`, { ...ACK, ...extra });
  const available = async (over: Record<string, unknown> = {}, biz = bizA) => {
    const id = await draft(over, biz);
    for (const p of ['submit', 'start-review']) expect((await op(id, p, creator)).status).toBe(200);
    const a = await op(id, 'approve'); expect(a.status, JSON.stringify(a)).toBe(200);
    expect((await op(id, 'schedule')).status).toBe(200); expect((await op(id, 'open')).status).toBe(200);
    return id;
  };
  const customer = async () => (await repos.customers.create({ phone: `+1557${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}` })).id;
  const eligible = async () => {
    const cid = await customer();
    const m = (await q(`INSERT INTO business_customer_memberships (customer_id, business_id, status) VALUES ($1,$2,'active') RETURNING id`, [cid, bizA]))[0].id;
    const a = (await q(`INSERT INTO loyalty_accounts (customer_id, business_id, membership_id) VALUES ($1,$2,$3) RETURNING id`, [cid, bizA, m]))[0].id;
    await q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount) VALUES ($1,$2,$3,$4,$5,20)`, [bizA, cid, m, a, randomUUID()]);
    return cid;
  };
  const reserve = (id: string, cid: string, holdMs = 3_600_000) => as(reviewer, 'POST', `/sponsorships/${id}/synthetic/reservations`, { ...ACK, customerId: cid, holdExpiresAt: iso(holdMs) });
  const inv = async (id: string) => (await q(`SELECT * FROM drop_inventory WHERE sponsorship_id = $1`, [id]))[0];
  const mkRule = async (isApproved: boolean) => {
    const spec = parseQualificationSpec({ combinator: 'ALL', pathways: [{ metric: 'recorded_purchases', threshold: 1 }] });
    const k = `drop_rule_${tag}_${++seq}`.toLowerCase().slice(0, 60);
    const id = (await q(`INSERT INTO qualification_rule_versions (rule_key, version, participant_type, spec, spec_hash, created_by_user_id) VALUES ($1,1,'customer',$2,$3,$4) RETURNING id`, [k, JSON.stringify(spec), hashSpec(spec), creatorId]))[0].id as string;
    if (isApproved) await q(`UPDATE qualification_rule_versions SET approval_state='approved', approved_at=now(), approved_by_user_id=$2 WHERE id=$1`, [id, creatorId]);
    return id;
  };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); repos = createRepositories(buildDb(client));
    const mk = async (e: string, admin: boolean) => { const id = (await repos.users.create({ email: e, fullName: 'u', passwordHash: 'x', status: 'active' })).id; if (admin) await q(`UPDATE users SET platform_role='admin' WHERE id=$1`, [id]); return id; };
    creatorId = await mk(`dp-creator-${run}@example.test`, true); reviewerId = await mk(`dp-reviewer-${run}@example.test`, true); const plain = await mk(`dp-plain-${run}@example.test`, false);
    creator = await signAccessToken(creatorId, SECRET); reviewer = await signAccessToken(reviewerId, SECRET); plainToken = await signAccessToken(plain, SECRET);
    bizA = (await repos.businesses.create({ name: `Drops A ${tag}`, slug: `dpa-${run}` })).id; bizB = (await repos.businesses.create({ name: `Drops B ${tag}`, slug: `dpb-${run}` })).id;
    await q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`);
    approved = await mkRule(true);
  });
  afterAll(async () => { await q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`).catch(() => undefined); await client?.end(); });

  it('control matrix: every path is a generic 404 before authentication unless the value is exactly "true"; admin only when on', async () => {
    const id = randomUUID();
    for (const [m, p] of [['POST', '/sponsorships'], ['POST', `/sponsorships/${id}/approve`], ['POST', `/sponsorships/${id}/synthetic/reservations`], ['POST', `/reservations/${id}/synthetic/allocate`], ['GET', `/sponsorships/${id}/evidence`], ['GET', `/businesses/${id}/sponsorships`]] as const) {
      for (const flag of [undefined, 'false', 'TRUE', '1', ' true', 'yes', '']) expect((await http(m, p, { token: creator, flag, body: m === 'POST' ? ACK : undefined })).status, `${m} ${p} ${flag}`).toBe(404);
    }
    expect((await http('GET', `/businesses/${bizA}/sponsorships`, { flag: ON })).status).toBe(401);
    expect((await http('GET', `/businesses/${bizA}/sponsorships`, { token: plainToken, flag: ON })).status).toBe(403);
    expect((await http('POST', '/sponsorships', { token: creator, flag: ON, body: {} })).status).toBeGreaterThanOrEqual(400); // synthetic acknowledgement missing
    expect(await q(`SELECT 1 FROM drop_sponsorships WHERE key LIKE $1`, [`dp_${tag}%`])).toHaveLength(0);
  });

  it('there is no payment, price, tax, fee or sponsor/customer route: no such column exists and the paths are absent', async () => {
    const cols = await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'drop\\_%' AND column_name ~* '(price|amount|payment|fee|tax|currency|cost|invoice|stripe)'`);
    expect(cols).toEqual([]);
    const id = await draft();
    for (const [m, p] of [['POST', `/sponsorships/${id}/pay`], ['POST', '/payments'], ['POST', `/sponsorships/${id}/collect`], ['GET', '/me/drops']] as const) expect((await as(creator, m, p, ACK)).status, p).toBe(404);
  });

  it('offer lifecycle: independent review (the creator cannot approve), legal transitions only, versions only in draft, reasons required', async () => {
    const id = await draft();
    expect((await op(id, 'approve', reviewer)).error?.code).toBe('SPONSORSHIP_TRANSITION_NOT_ALLOWED');
    await op(id, 'submit', creator); await op(id, 'start-review', creator);
    const self = await op(id, 'approve', creator); expect(self.status).toBe(403); expect(self.error?.code).toBe('SEPARATION_OF_DUTIES');
    const v2 = await as(creator, 'POST', `/sponsorships/${id}/versions`, { ...ACK, productName: 'x', description: 'y', quantityTotal: 5, collectionMethod: 'm', collectionLocation: 'l', collectionWindowStart: iso(0), collectionWindowEnd: iso(86_400_000), offerExpiresAt: iso(86_400_000), qualificationRuleVersionId: approved });
    expect(v2.error?.code).toBe('SPONSORSHIP_NOT_DRAFT');
    expect((await op(id, 'return-to-draft', reviewer)).status).toBeGreaterThanOrEqual(400); // reason required
    expect((await op(id, 'return-to-draft', reviewer, { reason: 'Needs a clearer description.' })).data.status).toBe('draft');
    expect((await as(creator, 'POST', `/sponsorships/${id}/versions`, { ...ACK, productName: 'Better', description: 'Clearer.', quantityTotal: 5, collectionMethod: 'm', collectionLocation: 'l', collectionWindowStart: iso(0), collectionWindowEnd: iso(86_400_000), offerExpiresAt: iso(86_400_000), qualificationRuleVersionId: approved })).data.version).toBe(2);
    for (const p of ['submit', 'start-review']) await op(id, p, creator);
    const ok2 = await op(id, 'approve'); expect(ok2.data.status).toBe('approved');
    expect(await inv(id)).toMatchObject({ total_quantity: 5, reserved: 0, allocated: 0, collected: 0, expired: 0 }); // inventory at the APPROVED (latest) version quantity
    expect((await op(id, 'open')).error?.code).toBe('SPONSORSHIP_TRANSITION_NOT_ALLOWED'); // must be scheduled first
    expect((await op(id, 'suspend', reviewer)).status).toBeGreaterThanOrEqual(400);
    await expect(q(`UPDATE drop_sponsorship_versions SET quantity_total = 99 WHERE sponsorship_id = $1`, [id])).rejects.toThrow(/APPEND_ONLY/);
    await expect(q(`UPDATE drop_sponsorships SET business_id = $2 WHERE id = $1`, [id, bizB])).rejects.toThrow(/IMMUTABLE/);
    await expect(q(`UPDATE drop_sponsorships SET status = 'approved', reviewed_by_user_id = created_by_user_id WHERE id = $1`, [await draft()])).rejects.toThrow(/TRANSITION_NOT_ALLOWED/);
    await expect(q(`DELETE FROM drop_sponsorships WHERE id = $1`, [id])).rejects.toThrow(/IMMUTABLE/);
  });

  it('ATOMIC inventory: 8 parallel eligible customers on 3 units -> exactly 3 reserved, the rest INVENTORY_EXHAUSTED, counters exact, never negative or oversubscribed', async () => {
    const id = await available({ quantityTotal: 3 });
    const customers: string[] = []; for (let i = 0; i < 8; i++) customers.push(await eligible());
    const res = await Promise.all(customers.map((c) => reserve(id, c)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    expect(res.filter((r) => r.status === 409).every((r) => r.error?.code === 'INVENTORY_EXHAUSTED')).toBe(true);
    expect(await inv(id)).toMatchObject({ total_quantity: 3, reserved: 3 });
    expect(await q(`SELECT 1 FROM drop_reservations WHERE sponsorship_id = $1`, [id])).toHaveLength(3);
    expect((await as(reviewer, 'GET', `/sponsorships/${id}/evidence`)).data).toMatchObject({ chainOk: true, inventoryConsistent: true });
  });

  it('duplicate reservations are impossible (idempotent per customer) and the database refuses every inventory bypass', async () => {
    const id = await available({ quantityTotal: 2 }); const c = await eligible();
    const a = await reserve(id, c); const b = await reserve(id, c);
    expect(a.status).toBe(201); expect(b.status).toBe(200); expect(b.data.id).toBe(a.data.id);
    expect((await inv(id)).reserved).toBe(1);
    await expect(q(`UPDATE drop_inventory SET reserved = 0 WHERE sponsorship_id = $1`, [id])).rejects.toThrow(/INVENTORY_CONTROLLED/);
    await expect(q(`UPDATE drop_inventory SET total_quantity = 99 WHERE sponsorship_id = $1`, [id])).rejects.toThrow(/INVENTORY_CONTROLLED/);
    await expect(q(`DELETE FROM drop_inventory WHERE sponsorship_id = $1`, [id])).rejects.toThrow(/INVENTORY_CONTROLLED/);
    await expect(q(`INSERT INTO drop_reservations (sponsorship_id, customer_id, hold_expires_at, eligibility_evidence, created_by_user_id) VALUES ($1,$2, now() + interval '1 hour', '{}', $3)`, [id, c, creatorId])).rejects.toThrow(/duplicate|unique/i);
    const c2 = await customer(); const c3 = await customer();
    await q(`INSERT INTO drop_reservations (sponsorship_id, customer_id, hold_expires_at, eligibility_evidence, created_by_user_id) VALUES ($1,$2, now() + interval '1 hour', '{}', $3)`, [id, c2, creatorId]);
    await expect(q(`INSERT INTO drop_reservations (sponsorship_id, customer_id, hold_expires_at, eligibility_evidence, created_by_user_id) VALUES ($1,$2, now() + interval '1 hour', '{}', $3)`, [id, c3, creatorId])).rejects.toThrow(/EXHAUSTED/);
    await expect(q(`UPDATE drop_reservations SET synthetic = false WHERE id = $1`, [a.data.id])).rejects.toThrow(/IMMUTABLE|synthetic/);
    await expect(q(`DELETE FROM drop_reservations WHERE id = $1`, [a.data.id])).rejects.toThrow(/IMMUTABLE/);
    for (const t of ['drop_sponsorships', 'drop_sponsorship_versions', 'drop_inventory', 'drop_reservations', 'drop_events']) await expect(q(`TRUNCATE ${t}`), t).rejects.toThrow();
  });

  it('eligibility is the shared engine, fail closed: ineligible customers and unapproved rules reserve nothing; allocation re-checks and releases the unit', async () => {
    const id = await available({ quantityTotal: 2 });
    expect((await reserve(id, await customer())).error?.code).toBe('ELIGIBILITY_NOT_MET');
    const rule = await mkRule(true); const sid = await available({ quantityTotal: 2, qualificationRuleVersionId: rule });
    const c = await eligible(); const r = await reserve(sid, c); expect(r.status).toBe(201);
    // evidence disappears (owner-level in the disposable DB) while the rule stays approved: the re-check at allocation releases the unit
    await q(`ALTER TABLE loyalty_purchase_events DISABLE TRIGGER USER`);
    try { await q(`DELETE FROM loyalty_purchase_events WHERE customer_id = $1`, [c]); } finally { await q(`ALTER TABLE loyalty_purchase_events ENABLE TRIGGER USER`); }
    const al = await as(reviewer, 'POST', `/reservations/${r.data.id}/synthetic/allocate`, ACK);
    expect(al.status).toBe(409); expect(al.error?.code).toBe('ELIGIBILITY_NOT_MET');
    expect((await q(`SELECT status FROM drop_reservations WHERE id = $1`, [r.data.id]))[0].status).toBe('released'); // persisted
    expect(await inv(sid)).toMatchObject({ reserved: 0, allocated: 0 });
    // the rule is retired while a hold exists: allocation fails closed and the hold is NOT converted
    const c2 = await eligible(); const r2 = await reserve(sid, c2); expect(r2.status).toBe(201);
    await q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE id = $1`, [rule]);
    const al2 = await as(reviewer, 'POST', `/reservations/${r2.data.id}/synthetic/allocate`, ACK);
    expect(al2.error?.code).toBe('QUALIFICATION_NOT_APPROVED');
    expect((await q(`SELECT status FROM drop_reservations WHERE id = $1`, [r2.data.id]))[0].status).toBe('reserved');
    expect((await reserve(sid, await eligible())).error?.code).toBe('QUALIFICATION_NOT_APPROVED');
  });

  it('allocation: reserved -> allocated; an allocated unit is never silently withdrawn; suspension stops NEW reservations but keeps allocations', async () => {
    const id = await available({ quantityTotal: 3 }); const c1 = await eligible(); const c2 = await eligible();
    const r1 = await reserve(id, c1); const al = await as(reviewer, 'POST', `/reservations/${r1.data.id}/synthetic/allocate`, ACK);
    expect(al.status, JSON.stringify(al)).toBe(200); expect(al.data.status).toBe('allocated');
    expect((await as(reviewer, 'POST', `/reservations/${r1.data.id}/synthetic/allocate`, ACK)).data.status).toBe('allocated'); // idempotent
    const rel = await as(reviewer, 'POST', `/reservations/${r1.data.id}/synthetic/release`, { ...ACK, reason: 'sponsor withdrawal' });
    expect(rel.status).toBe(409); expect(rel.error?.code).toBe('RESERVATION_TRANSITION_NOT_ALLOWED');
    await expect(q(`UPDATE drop_reservations SET status = 'released', status_reason = 'x' WHERE id = $1`, [r1.data.id])).rejects.toThrow(/TRANSITION_NOT_ALLOWED/);
    await expect(q(`UPDATE drop_reservations SET status = 'reserved' WHERE id = $1`, [r1.data.id])).rejects.toThrow(/TRANSITION_NOT_ALLOWED/);
    expect(await inv(id)).toMatchObject({ reserved: 0, allocated: 1 });
    expect((await op(id, 'suspend', reviewer, { reason: 'investigating' })).data.status).toBe('suspended');
    expect((await reserve(id, c2)).error?.code).toBe('SPONSORSHIP_NOT_AVAILABLE');
    expect((await q(`SELECT status FROM drop_reservations WHERE id = $1`, [r1.data.id]))[0].status).toBe('allocated');
    expect((await op(id, 'resume')).data.status).toBe('available');
    expect((await reserve(id, c2)).status).toBe(201);
    const cancelled = await op(id, 'cancel', reviewer, { reason: 'sponsor cancelled' });
    expect(cancelled.data.status).toBe('cancelled');
    expect((await q(`SELECT status FROM drop_reservations WHERE id = $1`, [r1.data.id]))[0].status).toBe('allocated'); // allocated units stay honoured
    expect((await op(id, 'resume')).error?.code).toBe('SPONSORSHIP_TRANSITION_NOT_ALLOWED'); // cancellation is final
  });

  it('holds expire and return units to the pool; an uncollected allocation expires after the collection window without returning to the pool', async () => {
    const id = await available({ quantityTotal: 1 }); const c1 = await eligible(); const c2 = await eligible();
    const r = await reserve(id, c1, 1200); expect(r.status).toBe(201);
    expect((await reserve(id, c2)).error?.code).toBe('INVENTORY_EXHAUSTED');
    expect((await as(reviewer, 'POST', `/sponsorships/${id}/synthetic/expire-due`, ACK)).data.holdsExpired).toBe(0); // not yet due
    await new Promise((res) => setTimeout(res, 1500));
    expect((await as(reviewer, 'POST', `/reservations/${r.data.id}/synthetic/allocate`, ACK)).error?.code).toBe('RESERVATION_NOT_ALLOWED');
    expect((await as(reviewer, 'POST', `/sponsorships/${id}/synthetic/expire-due`, ACK)).data.holdsExpired).toBe(1);
    expect(await inv(id)).toMatchObject({ reserved: 0 });
    const r2 = await reserve(id, c2); expect(r2.status).toBe(201);
    // allocation whose collection window passes
    const sid = await available({ quantityTotal: 1, collectionWindowStart: iso(-3_600_000), collectionWindowEnd: iso(2000) });
    const c3 = await eligible(); const rr = await reserve(sid, c3);
    expect((await as(reviewer, 'POST', `/reservations/${rr.data.id}/synthetic/allocate`, ACK)).status).toBe(200);
    expect((await as(reviewer, 'POST', `/sponsorships/${sid}/synthetic/expire-due`, ACK)).data.allocationsExpired).toBe(0);
    await new Promise((res) => setTimeout(res, 2300));
    expect((await as(reviewer, 'POST', `/sponsorships/${sid}/synthetic/expire-due`, ACK)).data.allocationsExpired).toBe(1);
    expect(await inv(sid)).toMatchObject({ allocated: 0, expired: 1, total_quantity: 1 });
    expect((await reserve(sid, await eligible())).error?.code).toBe('INVENTORY_EXHAUSTED'); // the expired unit is NOT returned to the pool
    expect((await as(reviewer, 'GET', `/sponsorships/${sid}/evidence`)).data).toMatchObject({ chainOk: true, inventoryConsistent: true });
  });

  it('tenant isolation: a business sees only its own sponsorships and aggregate counts, never another business or any customer identity', async () => {
    const a = await available({ quantityTotal: 2 }, bizA); const b = await available({ quantityTotal: 4 }, bizB);
    const c = await eligible(); await reserve(a, c);
    const la = (await as(reviewer, 'GET', `/businesses/${bizA}/sponsorships`)).data as { id: string; inventory: { reserved: number; total: number; available: number } }[];
    const lb = (await as(reviewer, 'GET', `/businesses/${bizB}/sponsorships`)).data as { id: string }[];
    expect(la.map((x) => x.id)).toContain(a); expect(la.map((x) => x.id)).not.toContain(b);
    expect(lb.map((x) => x.id)).toContain(b); expect(lb.map((x) => x.id)).not.toContain(a);
    expect(la.find((x) => x.id === a)?.inventory).toMatchObject({ total: 2, reserved: 1, available: 1 });
    expect(JSON.stringify(la)).not.toContain(c);
    expect(JSON.stringify(la)).not.toMatch(/customer/i);
    expect(await q(`SELECT 1 FROM drop_sponsorships WHERE id = $1 AND business_id = $2`, [b, bizA])).toHaveLength(0);
  });

  it('evidence chain: contiguous, hash-linked, DB-enforced linkage, tamper detected', async () => {
    const id = await available({ quantityTotal: 1 }); await reserve(id, await eligible());
    expect((await as(reviewer, 'GET', `/sponsorships/${id}/evidence`)).data).toMatchObject({ chainOk: true, inventoryConsistent: true });
    await expect(q(`INSERT INTO drop_events (sponsorship_id, seq, prev_hash, hash, event, actor_user_id) VALUES ($1, 50, repeat('a',64), repeat('b',64), '{}', $2)`, [id, creatorId])).rejects.toThrow(/CHAIN_BROKEN/);
    await expect(q(`UPDATE drop_events SET event = '{}' WHERE sponsorship_id = $1`, [id])).rejects.toThrow(/APPEND_ONLY/);
    await q(`ALTER TABLE drop_events DISABLE TRIGGER drop_events_append_only_trg`);
    try {
      await q(`UPDATE drop_events SET event = jsonb_set(event, '{reservationId}', '"tampered"') WHERE sponsorship_id = $1 AND event->>'type' = 'reserved'`, [id]);
      expect((await as(reviewer, 'GET', `/sponsorships/${id}/evidence`)).data.chainOk).toBe(false);
    } finally { await q(`ALTER TABLE drop_events ENABLE ALWAYS TRIGGER drop_events_append_only_trg`); }
  });
});
