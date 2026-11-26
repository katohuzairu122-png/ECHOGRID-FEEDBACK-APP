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
import { platformShuffleRoutes } from '../../src/platform/shuffle.routes';
import { signAccessToken } from '../../src/auth/jwt';
import { hashSpec, parseQualificationSpec } from '../../src/qualification/qualification-spec';

/**
 * TSH-05/TSH-04 integration against real PostgreSQL: synthetic-only invitations, entries, capacity, selection and evidence chain. Synthetic data only; the
 * approved rule exists ONLY in this disposable test database.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const SECRET = 'shuffle-fixture-access-secret';
const run = randomUUID();
const tag = run.replace(/[0-9-]/g, (d) => 'abcdefghijk'[d.charCodeAt(0) % 11] as string);
const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/platform/shuffle', platformShuffleRoutes);
app.onError(errorHandler);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
async function http(method: string, path: string, o: { token?: string; body?: unknown; flag?: string | undefined } = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined && method !== 'GET') headers.set('Content-Type', 'application/json');
  const env = { HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, TENTASHIP_SHUFFLE_ENABLED: o.flag } as unknown as Bindings;
  const res = await app.request(`/api/v1/platform/shuffle${path}`, { method, headers, ...(o.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(o.body) }) }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text();
  let parsed: Envelope = {};
  try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* plain-text 404 */ }
  return { status: res.status, ...parsed };
}


describe.skipIf(!databaseUrl)('TSH-05 invitations, entries and synthetic selection (real HTTP, real PostgreSQL)', () => {
  let client: Client; let repos: ReturnType<typeof createRepositories>; let adminId: string; let adminToken: string; let biz: string; let approved: string;
  const q = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows;
  const ON = 'true'; let seq = 0;
  const key = () => `sp_${tag}_${++seq}`.toLowerCase().slice(0, 60);
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  const ACK = { syntheticAcknowledged: true };
  const mkCampaign = async (over: Record<string, unknown> = {}) => {
    const r = await http('POST', '/campaigns', { token: adminToken, flag: ON, body: { key: key(), mode: 'limited', qualificationRuleVersionId: approved, minParticipants: 2, maxCapacity: 10, qualificationWindowStart: iso(-3_600_000), qualificationWindowEnd: iso(86_400_000), entryAcceptanceDeadline: iso(172_800_000),
      disclosure: { en: 'The outcome is determined by the server after the entry deadline using the final number of participants.' }, termsVersion: 'draft-1', closureConditions: 'Closes at the deadline.', cancellationConditions: 'May be cancelled before selection.', ...over } });
    expect(r.status, JSON.stringify(r)).toBe(201); return r.data as { campaign: { id: string }; version: { id: string; disclosureHash: string; termsVersion: string } };
  };
  const customer = async () => (await repos.customers.create({ phone: `+1558${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}` })).id;
  const qualified = async (versionId: string) => {
    const cid = await customer();
    const m = (await q(`INSERT INTO business_customer_memberships (customer_id, business_id, status) VALUES ($1,$2,'active') RETURNING id`, [cid, biz]))[0].id;
    const a = (await q(`INSERT INTO loyalty_accounts (customer_id, business_id, membership_id) VALUES ($1,$2,$3) RETURNING id`, [cid, biz, m]))[0].id;
    await q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount) VALUES ($1,$2,$3,$4,$5,20)`, [biz, cid, m, a, randomUUID()]);
    expect((await http('POST', `/versions/${versionId}/snapshots`, { token: adminToken, flag: ON, body: { customerId: cid } })).status).toBe(201);
    return cid;
  };
  const invite = async (versionId: string, cid: string, expiresInMs = 3_600_000) => {
    const r = await http('POST', `/versions/${versionId}/synthetic/invitations`, { token: adminToken, flag: ON, body: { ...ACK, customerId: cid, expiresAt: iso(expiresInMs) } });
    expect(r.status, JSON.stringify(r)).toBe(201); return r.data.id as string;
  };
  const accept = (id: string, v: { version: { disclosureHash: string; termsVersion: string } }) => http('POST', `/invitations/${id}/synthetic/accept`, { token: adminToken, flag: ON, body: { ...ACK, termsVersion: v.version.termsVersion, disclosureHash: v.version.disclosureHash } });
  const admitted = async (v: Awaited<ReturnType<typeof mkCampaign>>, n: number) => { const out: string[] = []; for (let i = 0; i < n; i++) { const inv = await invite(v.version.id, await qualified(v.version.id)); const r = await accept(inv, v); expect(r.status, JSON.stringify(r)).toBe(201); out.push(r.data.entryId); } return out; };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); repos = createRepositories(buildDb(client));
    adminId = (await repos.users.create({ email: `sp-admin-${run}@example.test`, fullName: 'u', passwordHash: 'x', status: 'active' })).id;
    await q(`UPDATE users SET platform_role='admin' WHERE id=$1`, [adminId]);
    adminToken = await signAccessToken(adminId, SECRET);
    biz = (await repos.businesses.create({ name: `Participation ${tag}`, slug: `sp-${run}` })).id;
    await q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`);
    approved = await mkRule(true);
  });
  const mkRule = async (isApproved: boolean) => {
    const spec = parseQualificationSpec({ combinator: 'ALL', pathways: [{ metric: 'recorded_purchases', threshold: 1 }] });
    const k = `part_rule_${tag}_${++seq}`.toLowerCase().slice(0, 60);
    const id = (await q(`INSERT INTO qualification_rule_versions (rule_key, version, participant_type, spec, spec_hash, created_by_user_id) VALUES ($1,1,'customer',$2,$3,$4) RETURNING id`, [k, JSON.stringify(spec), hashSpec(spec), adminId]))[0].id as string;
    if (isApproved) await q(`UPDATE qualification_rule_versions SET approval_state='approved', approved_at=now(), approved_by_user_id=$2 WHERE id=$1`, [id, adminId]);
    return id;
  };
  afterAll(async () => { await q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`).catch(() => undefined); await client?.end(); });

  it('control off: every synthetic path is a generic 404; the harness needs the explicit synthetic acknowledgement', async () => {
    const id = randomUUID();
    for (const [m, p] of [['POST', `/versions/${id}/synthetic/invitations`], ['POST', `/invitations/${id}/synthetic/accept`], ['POST', `/versions/${id}/synthetic/selection`], ['GET', `/versions/${id}/evidence`], ['POST', `/entries/${id}/synthetic/cancel`]] as const) {
      for (const flag of [undefined, 'false', 'TRUE', '1']) expect((await http(m, p, { token: adminToken, flag, body: m === 'POST' ? ACK : undefined })).status, `${m} ${p} ${flag}`).toBe(404);
    }
    const v = await mkCampaign(); const cid = await qualified(v.version.id);
    const missing = await http('POST', `/versions/${v.version.id}/synthetic/invitations`, { token: adminToken, flag: ON, body: { customerId: cid, expiresAt: iso(60_000) } });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await q(`SELECT 1 FROM shuffle_invitations WHERE campaign_version_id = $1`, [v.version.id])).toHaveLength(0);
  });

  it('invitation: only for a QUALIFIED snapshot; idempotent; expiry bounded; notification intent is held and in-app only; bound to one version', async () => {
    const v = await mkCampaign();
    const plain = await customer();
    expect((await http('POST', `/versions/${v.version.id}/synthetic/invitations`, { token: adminToken, flag: ON, body: { ...ACK, customerId: plain, expiresAt: iso(60_000) } })).error?.code).toBe('INVITATION_NOT_QUALIFIED');
    const cid = await qualified(v.version.id);
    expect((await http('POST', `/versions/${v.version.id}/synthetic/invitations`, { token: adminToken, flag: ON, body: { ...ACK, customerId: cid, expiresAt: iso(999_000_000) } })).error?.code).toBe('INVITATION_EXPIRY_INVALID');
    expect((await http('POST', `/versions/${v.version.id}/synthetic/invitations`, { token: adminToken, flag: ON, body: { ...ACK, customerId: cid, expiresAt: iso(-1000) } })).error?.code).toBe('INVITATION_EXPIRY_INVALID');
    const id = await invite(v.version.id, cid);
    const again = await http('POST', `/versions/${v.version.id}/synthetic/invitations`, { token: adminToken, flag: ON, body: { ...ACK, customerId: cid, expiresAt: iso(60_000) } });
    expect(again.status).toBe(200); expect(again.data.id).toBe(id);
    expect(await q(`SELECT delivery_state, channel FROM shuffle_notification_intents WHERE invitation_id = $1`, [id])).toEqual([{ delivery_state: 'held', channel: 'in_app' }]);
    await expect(q(`INSERT INTO shuffle_notification_intents (invitation_id, channel) VALUES ($1,'email')`, [id])).rejects.toThrow(/held|check/i);
    await expect(q(`UPDATE shuffle_notification_intents SET delivery_state = 'sent' WHERE invitation_id = $1`, [id])).rejects.toThrow(/APPEND_ONLY/);
    // a business invitation / referral never creates a Shuffle invitation or entry
    expect(await q(`SELECT 1 FROM shuffle_entries WHERE customer_id = $1`, [cid])).toHaveLength(0);
  });

  it('acceptance binds the exact terms and disclosure hash, re-evaluates eligibility, is idempotent and admits (synthetic)', async () => {
    const v = await mkCampaign(); const cid = await qualified(v.version.id); const inv = await invite(v.version.id, cid);
    const wrong = await http('POST', `/invitations/${inv}/synthetic/accept`, { token: adminToken, flag: ON, body: { ...ACK, termsVersion: v.version.termsVersion, disclosureHash: 'a'.repeat(64) } });
    expect(wrong.status).toBe(409); expect(wrong.error?.code).toBe('DISCLOSURE_MISMATCH');
    expect((await http('POST', `/invitations/${inv}/synthetic/accept`, { token: adminToken, flag: ON, body: { ...ACK, termsVersion: 'other', disclosureHash: v.version.disclosureHash } })).error?.code).toBe('DISCLOSURE_MISMATCH');
    await http('POST', `/invitations/${inv}/synthetic/view`, { token: adminToken, flag: ON, body: ACK });
    const a = await accept(inv, v); expect(a.status, JSON.stringify(a)).toBe(201); expect(a.data.status).toBe('admitted');
    const b = await accept(inv, v); expect(b.status).toBe(200); expect(b.data.entryId).toBe(a.data.entryId);
    const [e] = await q(`SELECT synthetic, accepted_terms_version, accepted_disclosure_hash FROM shuffle_entries WHERE id = $1`, [a.data.entryId]);
    expect(e).toMatchObject({ synthetic: true, accepted_terms_version: v.version.termsVersion, accepted_disclosure_hash: v.version.disclosureHash });
    expect(await q(`SELECT to_status FROM shuffle_invitation_events WHERE invitation_id = $1 ORDER BY created_at, id`, [inv])).toHaveLength(3);
  });

  it('eligibility is RE-CHECKED at acceptance and fails closed: a retired rule withdraws the invitation (persisted) and admits nobody', async () => {
    const rule = await mkRule(true);
    const v = await mkCampaign({ qualificationRuleVersionId: rule }); const cid = await qualified(v.version.id); const inv = await invite(v.version.id, cid);
    await q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE id = $1`, [rule]);
    const r = await accept(inv, v);
    expect(r.status).toBe(409); expect(r.error?.code).toBe('ELIGIBILITY_NOT_MET');
    expect((await q(`SELECT status FROM shuffle_invitations WHERE id = $1`, [inv]))[0].status).toBe('withdrawn');
    expect(await q(`SELECT 1 FROM shuffle_entries WHERE invitation_id = $1`, [inv])).toHaveLength(0);
  });

  it('declined, withdrawn and expired invitations are final; early expiry is refused by the database; withdrawn admitted entries are cancelled with a reason', async () => {
    const v = await mkCampaign();
    const c1 = await qualified(v.version.id); const i1 = await invite(v.version.id, c1);
    expect((await http('POST', `/invitations/${i1}/synthetic/decline`, { token: adminToken, flag: ON, body: ACK })).data.status).toBe('declined');
    expect((await accept(i1, v)).error?.code).toBe('INVITATION_TRANSITION_NOT_ALLOWED');
    await expect(q(`UPDATE shuffle_invitations SET status = 'accepted' WHERE id = $1`, [i1])).rejects.toThrow(/TRANSITION_NOT_ALLOWED/);
    const c2 = await qualified(v.version.id); const i2 = await invite(v.version.id, c2);
    await expect(q(`UPDATE shuffle_invitations SET status = 'expired' WHERE id = $1`, [i2])).rejects.toThrow(/TRANSITION_NOT_ALLOWED/);
    const c3 = await qualified(v.version.id); const i3 = await invite(v.version.id, c3); const en = (await accept(i3, v)).data.entryId;
    expect((await http('POST', `/invitations/${i3}/synthetic/withdraw`, { token: adminToken, flag: ON, body: { ...ACK, reason: 'qualification invalidated' } })).data.status).toBe('withdrawn');
    expect((await q(`SELECT status, status_reason FROM shuffle_entries WHERE id = $1`, [en]))[0]).toEqual({ status: 'cancelled', status_reason: 'qualification invalidated' });
    expect((await http('POST', `/invitations/${i3}/synthetic/withdraw`, { token: adminToken, flag: ON, body: { ...ACK } })).status).toBeGreaterThanOrEqual(400);
    // expired: shorten via owner-level disable of the guard is not allowed; use a 1.2s invitation and wait
    const c4 = await qualified(v.version.id); const i4 = await invite(v.version.id, c4, 1200);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await accept(i4, v)).error?.code).toBe('INVITATION_EXPIRED');
    expect((await http('POST', `/versions/${v.version.id}/synthetic/expire`, { token: adminToken, flag: ON, body: ACK })).data.expired).toBe(1);
    expect((await q(`SELECT status FROM shuffle_invitations WHERE id = $1`, [i4]))[0].status).toBe('expired');
  });

  it('capacity is never exceeded, even under concurrent acceptance (one admitted of five parallel)', async () => {
    const v = await mkCampaign({ minParticipants: 1, maxCapacity: 1 });
    const invs: string[] = []; for (let i = 0; i < 5; i++) invs.push(await invite(v.version.id, await qualified(v.version.id)));
    const res = await Promise.all(invs.map((id) => accept(id, v)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409).every((r) => r.error?.code === 'CAPACITY_REACHED')).toBe(true);
    expect(await q(`SELECT 1 FROM shuffle_entries WHERE campaign_version_id = $1 AND status = 'admitted'`, [v.version.id])).toHaveLength(1);
  });

  it('the database refuses bypasses: non-synthetic rows, deletes, entries without an accepted invitation, invitations for unqualified snapshots, broken chain', async () => {
    const v = await mkCampaign(); const cid = await qualified(v.version.id); const inv = await invite(v.version.id, cid);
    await expect(q(`UPDATE shuffle_invitations SET synthetic = false WHERE id = $1`, [inv])).rejects.toThrow();
    await expect(q(`DELETE FROM shuffle_invitations WHERE id = $1`, [inv])).rejects.toThrow(/IMMUTABLE/);
    await expect(q(`INSERT INTO shuffle_entries (invitation_id, campaign_version_id, customer_id, accepted_terms_version, accepted_disclosure_hash) VALUES ($1,$2,$3,$4,$5)`, [inv, v.version.id, cid, v.version.termsVersion, v.version.disclosureHash])).rejects.toThrow(/ENTRY_NOT_ALLOWED/);
    const nq = await customer();
    await expect(q(`INSERT INTO shuffle_invitations (campaign_id, campaign_version_id, customer_id, snapshot_id, expires_at, created_by_user_id) VALUES ($1,$2,$3,$4,now() + interval '1 hour',$5)`, [v.campaign.id, v.version.id, nq, randomUUID(), adminId])).rejects.toThrow();
    await expect(q(`INSERT INTO shuffle_allocation_events (campaign_version_id, seq, prev_hash, hash, event, actor_user_id) VALUES ($1, 99, NULL, repeat('a',64), '{}', $2)`, [v.version.id, adminId])).rejects.toThrow();
    await expect(q(`INSERT INTO shuffle_allocation_events (campaign_version_id, seq, prev_hash, hash, event, actor_user_id) VALUES ($1, 2, repeat('b',64), repeat('a',64), '{}', $2)`, [v.version.id, adminId])).rejects.toThrow(/CHAIN_BROKEN/);
    for (const t of ['shuffle_invitations', 'shuffle_entries', 'shuffle_allocation_events', 'shuffle_selection_results', 'shuffle_invitation_events', 'shuffle_notification_intents']) await expect(q(`TRUNCATE ${t}`), t).rejects.toThrow();
  });

  it('suspension halts invitations, acceptance and selection; resume restores them', async () => {
    const v = await mkCampaign({ minParticipants: 1 }); const c1 = await qualified(v.version.id); const i1 = await invite(v.version.id, c1);
    const c2 = await qualified(v.version.id);
    await http('POST', `/campaigns/${v.campaign.id}/suspend`, { token: adminToken, flag: ON, body: { reason: 'fraud signal' } });
    expect((await accept(i1, v)).error?.code).toBe('CAMPAIGN_NOT_DRAFT');
    expect((await http('POST', `/versions/${v.version.id}/synthetic/invitations`, { token: adminToken, flag: ON, body: { ...ACK, customerId: c2, expiresAt: iso(60_000) } })).error?.code).toBe('CAMPAIGN_NOT_DRAFT');
    expect((await http('POST', `/versions/${v.version.id}/synthetic/selection`, { token: adminToken, flag: ON, body: { ...ACK, winnerCount: 1 } })).error?.code).toBe('CAMPAIGN_NOT_DRAFT');
    await http('POST', `/campaigns/${v.campaign.id}/resume`, { token: adminToken, flag: ON });
    expect((await accept(i1, v)).status).toBe(201);
  });

  it('synthetic selection: min participants, mode rules, once per version, recorded evidence verifies, tampering is detected, entries lock after selection', async () => {
    const lim = await mkCampaign({ minParticipants: 3, maxCapacity: 10 });
    await admitted(lim, 2);
    expect((await http('POST', `/versions/${lim.version.id}/synthetic/selection`, { token: adminToken, flag: ON, body: { ...ACK, winnerCount: 1 } })).error?.code).toBe('MIN_PARTICIPANTS_NOT_REACHED');
    const entries = await admitted(lim, 2);
    expect((await http('POST', `/versions/${lim.version.id}/synthetic/selection`, { token: adminToken, flag: ON, body: { ...ACK, winnerCount: 9 } })).error?.code).toBe('WINNER_COUNT_INVALID');
    const s = await http('POST', `/versions/${lim.version.id}/synthetic/selection`, { token: adminToken, flag: ON, body: { ...ACK, winnerCount: 2 } });
    expect(s.status, JSON.stringify(s)).toBe(201); expect(s.data).toMatchObject({ entrantCount: 4, winnerCount: 2 });
    expect(JSON.stringify(s.data)).not.toMatch(/customer|entryId|selected/i); // the response never exposes who was selected
    const again = await http('POST', `/versions/${lim.version.id}/synthetic/selection`, { token: adminToken, flag: ON, body: { ...ACK, winnerCount: 1 } });
    expect(again.status).toBe(200); expect(again.data.winnerCount).toBe(2);
    const ev = await http('GET', `/versions/${lim.version.id}/evidence`, { token: adminToken, flag: ON });
    expect(ev.data).toMatchObject({ chainOk: true, selectionRecorded: true, selectionOk: true });
    expect((await http('POST', `/entries/${entries[0]}/synthetic/cancel`, { token: adminToken, flag: ON, body: { ...ACK, reason: 'x' } })).error?.code).toBe('ENTRY_LOCKED_AFTER_SELECTION');
    await expect(q(`UPDATE shuffle_selection_results SET winner_count = 1 WHERE campaign_version_id = $1`, [lim.version.id])).rejects.toThrow(/APPEND_ONLY/);
    // tamper (owner-level, trigger temporarily disabled): the chain and the selection verification both detect it
    await q(`ALTER TABLE shuffle_allocation_events DISABLE TRIGGER shuffle_alloc_events_append_only_trg`);
    try {
      await q(`UPDATE shuffle_allocation_events SET event = jsonb_set(event, '{entrantIds,0}', '"00000000-0000-0000-0000-000000000000"') WHERE campaign_version_id = $1 AND event->>'type' = 'selection_recorded'`, [lim.version.id]);
      const bad = await http('GET', `/versions/${lim.version.id}/evidence`, { token: adminToken, flag: ON });
      expect(bad.data.chainOk).toBe(false); expect(bad.data.selectionOk).toBe(false);
    } finally { await q(`ALTER TABLE shuffle_allocation_events ENABLE ALWAYS TRIGGER shuffle_alloc_events_append_only_trg`); }
    // guaranteed mode: every admitted entry must be selected
    const g = await mkCampaign({ mode: 'guaranteed', minParticipants: 2 }); await admitted(g, 3);
    expect((await http('POST', `/versions/${g.version.id}/synthetic/selection`, { token: adminToken, flag: ON, body: { ...ACK, winnerCount: 2 } })).error?.code).toBe('GUARANTEED_MODE_REQUIRES_ALL');
    expect((await http('POST', `/versions/${g.version.id}/synthetic/selection`, { token: adminToken, flag: ON, body: { ...ACK, winnerCount: 3 } })).status).toBe(201);
  });

  it('cancelled campaign is final: nothing can be invited, accepted or selected', async () => {
    const v = await mkCampaign({ minParticipants: 1 }); const c = await qualified(v.version.id); const i = await invite(v.version.id, c);
    await http('POST', `/campaigns/${v.campaign.id}/cancel`, { token: adminToken, flag: ON, body: { reason: 'withdrawn' } });
    expect((await accept(i, v)).error?.code).toBe('CAMPAIGN_NOT_DRAFT');
    expect((await http('POST', `/campaigns/${v.campaign.id}/resume`, { token: adminToken, flag: ON })).error?.code).toBe('CAMPAIGN_TRANSITION_NOT_ALLOWED');
  });
});
