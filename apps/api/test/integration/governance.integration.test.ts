import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import type { Bindings } from '../../src/config/env';
import { errorHandler } from '../../src/lib/error-handler';
import { auditTrail } from '../../src/middleware/audit';
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { platformGovernanceRoutes } from '../../src/platform/governance.routes';
import { signCashierAccessToken } from '../../src/auth/jwt';
import { iso, makeFixtures, SECRET } from './helpers/tentaship-fixtures';

/** TSH-08 governance against real PostgreSQL: cases, append-only evidence, two-person overrides, operator gating, flag independence. Synthetic data only. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/platform/governance', platformGovernanceRoutes);
app.onError(errorHandler);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string; message: string } };
type Flags = { shuffle?: string | undefined; drops?: string | undefined };
async function http(method: string, path: string, o: { token?: string | undefined; body?: unknown; flags?: Flags | undefined } = {}): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = []; const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined && method !== 'GET') headers.set('Content-Type', 'application/json');
  const f = o.flags ?? { shuffle: 'true', drops: 'true' };
  const env = { HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, TENTASHIP_SHUFFLE_ENABLED: f.shuffle, TENTASHIP_DROPS_ENABLED: f.drops } as unknown as Bindings;
  const res = await app.request(`/api/v1/platform/governance${path}`, { method, headers, ...(o.body === undefined || method === 'GET' ? {} : { body: JSON.stringify(o.body) }) }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending);
  const text = await res.text(); let parsed: Envelope = {};
  try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* plain 404 */ }
  return { status: res.status, ...parsed };
}
const ACK = { syntheticAcknowledged: true };

describe.skipIf(!databaseUrl)('TSH-08 governance (real HTTP, real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>;
  let creator: { id: string; token: string }; let opener: { id: string; token: string }; let investigator: { id: string; token: string }; let resolver: { id: string; token: string }; let resolver2: { id: string; token: string }; let plain: { id: string; token: string };
  let biz: string; let rule: string;
  const as = (u: { token: string }, m: string, p: string, body?: unknown, flags?: Flags) => http(m, p, { token: u.token, body, flags });
  const shuffleCase = async (kind: 'fraud' | 'dispute' = 'fraud', entries = 2) => {
    const s = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries });
    const r = await as(opener, 'POST', '/cases', { ...ACK, kind, subjectType: 'shuffle_entry', subjectId: s.entryIds[0], classification: 'suspected_duplicate_participation', summary: 'Synthetic: two entries look related.' });
    expect(r.status, JSON.stringify(r)).toBe(201); return { ...s, caseId: r.data.id as string };
  };
  const evidence = (caseId: string, body = 'Synthetic evidence note.') => as(opener, 'POST', `/cases/${caseId}/evidence`, { ...ACK, kind: 'note', body });
  const reviewed = async (c: Awaited<ReturnType<typeof shuffleCase>>) => { expect((await as(investigator, 'POST', `/cases/${c.caseId}/start-review`, ACK)).status).toBe(200); };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client);
    creator = await f.user('gv-creator'); opener = await f.user('gv-opener'); investigator = await f.user('gv-investigator'); resolver = await f.user('gv-resolver'); resolver2 = await f.user('gv-resolver2'); plain = await f.user('gv-plain', false);
    biz = await f.business('gv');
    await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`);
    rule = await f.rule(creator.id);
    await f.q(`UPDATE governance_operators SET active = false, revoked_at = now(), revoked_by_user_id = (SELECT id FROM users ORDER BY created_at LIMIT 1), revocation_reason = 'synthetic test reset' WHERE revoked_at IS NULL`); // operators are empty/disabled by default await f.ensurePolicies();
  });
  afterAll(async () => { await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`).catch(() => undefined); await f.q(`UPDATE governance_operators SET active = false, revoked_at = now(), revoked_by_user_id = (SELECT id FROM users ORDER BY created_at LIMIT 1), revocation_reason = 'synthetic test reset' WHERE revoked_at IS NULL`).catch(() => undefined); await client?.end(); });

  it('control matrix: 404 before authentication when neither control is "true"; each subject family needs ITS OWN control; admin only', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    for (const flags of [{}, { shuffle: 'false', drops: 'TRUE' }, { shuffle: '1', drops: ' true' }]) {
      for (const [m, p] of [['POST', '/cases'], ['GET', `/cases/${id}`], ['POST', `/cases/${id}/decide`], ['POST', `/overrides/${id}/approve`], ['POST', `/overrides/${id}/execute`]] as const) {
        expect((await http(m, p, { token: opener.token, flags, body: m === 'POST' ? ACK : undefined })).status, `${m} ${p} ${JSON.stringify(flags)}`).toBe(404);
      }
    }
    expect((await http('GET', `/cases/${id}`, { flags: { shuffle: 'true' } })).status).toBe(401);
    expect((await as(plain, 'GET', `/cases/${id}`)).status).toBe(403);
    const cashier = await signCashierAccessToken(opener.id, SECRET, { sessionId: '00000000-0000-4000-8000-000000000002', businessId: '00000000-0000-4000-8000-000000000003' });
    const c = await http('GET', `/cases/${id}`, { token: cashier }); expect(c.status).toBe(403); expect(c.error?.code).toBe('CASHIER_ROUTE_DENIED');
    // family independence: a Shuffle subject with only Drops enabled (and vice versa) is a 404
    const s = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries: 1 });
    const onlyDrops = await as(opener, 'POST', '/cases', { ...ACK, kind: 'fraud', subjectType: 'shuffle_entry', subjectId: s.entryIds[0], classification: 'other', summary: 's' }, { drops: 'true' });
    expect(onlyDrops.status).toBe(404);
    const d = await f.dropScenario({ creatorId: creator.id, reviewerId: resolver.id, businessId: biz, ruleId: rule, quantity: 2 });
    const onlyShuffle = await as(opener, 'POST', '/cases', { ...ACK, kind: 'fraud', subjectType: 'drop_sponsorship', subjectId: d.sponsorshipId, classification: 'other', summary: 's' }, { shuffle: 'true' });
    expect(onlyShuffle.status).toBe(404);
    expect((await as(opener, 'POST', '/cases', { ...ACK, kind: 'fraud', subjectType: 'drop_sponsorship', subjectId: d.sponsorshipId, classification: 'other', summary: 's' }, { drops: 'true' })).status).toBe(201);
  });

  it('with NO operators assigned nothing can be reviewed, decided or overridden (execution disabled); there is no operator-assignment route', async () => {
    const c = await shuffleCase();
    const r = await as(investigator, 'POST', `/cases/${c.caseId}/start-review`, ACK);
    expect(r.status).toBe(403); expect(r.error?.code).toBe('OPERATOR_NOT_ASSIGNED');
    expect((await as(opener, 'POST', `/cases/${c.caseId}/overrides`, { ...ACK, scope: 'cancel_entry_before_selection', targetId: c.entryIds[0], justification: 'Synthetic justification text.', expiresAt: iso(60_000) })).error?.code).toBe('OVERRIDE_NOT_ALLOWED');
    for (const p of ['/operators', '/cases/operators', '/assign']) expect((await as(opener, 'POST', p, ACK)).status, p).toBe(404);
    await f.operator(plain.id, 'dispute_resolver'); // (an Owner-side grant in a disposable DB)
    await expect(f.q(`DELETE FROM governance_operators WHERE user_id = $1`, [plain.id])).rejects.toThrow(/APPEND_ONLY/);
    await expect(f.q(`UPDATE governance_operators SET role = 'fraud_investigator' WHERE user_id = $1`, [plain.id])).rejects.toThrow(/IMMUTABLE/);
    await f.q(`UPDATE governance_operators SET active = false, revoked_at = now(), revoked_by_user_id = $1, revocation_reason = 'synthetic test reset' WHERE user_id = $1`, [plain.id]);
  });

  it('case lifecycle with separation of duties: opener cannot review, the campaign creator cannot decide, only the assigned reviewer decides, decisions are never rewritten', async () => {
    await f.operator(investigator.id, 'fraud_investigator'); await f.operator(creator.id, 'fraud_investigator'); await f.operator(opener.id, 'fraud_investigator');
    const c = await shuffleCase();
    expect((await as(opener, 'POST', `/cases/${c.caseId}/start-review`, ACK)).error?.code).toBe('OPERATOR_NOT_ASSIGNED'); // opener cannot review their own case
    expect((await as(opener, 'POST', `/cases/${c.caseId}/escalate`, { ...ACK, reason: 'short' })).status).toBeGreaterThanOrEqual(400);
    expect((await as(opener, 'POST', `/cases/${c.caseId}/escalate`, { ...ACK, reason: 'Needs a second look from an investigator.' })).data.status).toBe('escalated');
    expect((await as(investigator, 'POST', `/cases/${c.caseId}/decide`, { ...ACK, decision: 'upheld', reason: 'Premature decision attempt.' })).error?.code).toBe('TRANSITION_NOT_ALLOWED');
    // the administrator who created the campaign is an assigned operator but cannot decide a case about their own campaign
    expect((await as(creator, 'POST', `/cases/${c.caseId}/start-review`, ACK)).status).toBe(200);
    const byCreator = await as(creator, 'POST', `/cases/${c.caseId}/decide`, { ...ACK, decision: 'no_action', reason: 'Creator deciding on own campaign.' });
    expect(byCreator.status).toBe(403); expect(byCreator.error?.code).toBe('SEPARATION_OF_DUTIES');
    const c2 = await shuffleCase(); await reviewed(c2);
    expect((await as(creator, 'POST', `/cases/${c2.caseId}/decide`, { ...ACK, decision: 'upheld', reason: 'Not the assigned reviewer.' })).status).toBeGreaterThanOrEqual(400);
    expect((await as(investigator, 'POST', `/cases/${c2.caseId}/decide`, { ...ACK, decision: 'upheld', reason: 'x' })).status).toBeGreaterThanOrEqual(400); // reason too short
    const dec = await as(investigator, 'POST', `/cases/${c2.caseId}/decide`, { ...ACK, decision: 'upheld', reason: 'Evidence supports the finding.' });
    expect(dec.status, JSON.stringify(dec)).toBe(200); expect(dec.data.status).toBe('decided');
    await expect(f.q(`UPDATE governance_cases SET decision = 'overturned' WHERE id = $1`, [c2.caseId])).rejects.toThrow(/TRANSITION_NOT_ALLOWED|IMMUTABLE/);
    await expect(f.q(`UPDATE governance_cases SET status = 'closed', decision = 'overturned' WHERE id = $1`, [c2.caseId])).rejects.toThrow(/IMMUTABLE/);
    await expect(f.q(`DELETE FROM governance_cases WHERE id = $1`, [c2.caseId])).rejects.toThrow(/IMMUTABLE/);
    expect((await as(opener, 'POST', `/cases/${c2.caseId}/close`, ACK)).data.status).toBe('closed');
    expect((await evidence(c2.caseId)).error?.code).toBe('CASE_CLOSED');
    // the entry was not changed by the case or its decision
    expect((await f.q(`SELECT status FROM shuffle_entries WHERE id = $1`, [c2.entryIds[0]]))[0].status).toBe('admitted');
    for (const t of ['governance_cases', 'governance_case_evidence', 'governance_events', 'governance_overrides', 'governance_operators']) await expect(f.q(`TRUNCATE ${t}`), t).rejects.toThrow();
  });

  it('evidence is append-only and chain-recorded; the fraud investigator and the dispute approver must be different people; subjects must exist', async () => {
    await f.operator(investigator.id, 'fraud_investigator'); await f.operator(resolver.id, 'dispute_resolver');
    const c = await shuffleCase('fraud'); const ev = await evidence(c.caseId); expect(ev.status).toBe(201);
    await expect(f.q(`UPDATE governance_case_evidence SET body = 'rewritten' WHERE id = $1`, [ev.data.id])).rejects.toThrow(/APPEND_ONLY/);
    await expect(f.q(`DELETE FROM governance_case_evidence WHERE id = $1`, [ev.data.id])).rejects.toThrow(/APPEND_ONLY/);
    await reviewed(c);
    await as(investigator, 'POST', `/cases/${c.caseId}/decide`, { ...ACK, decision: 'upheld', reason: 'Fraud signal confirmed on evidence.' });
    // a linked dispute: the dispute approver cannot be the person who reviewed the related fraud case
    await f.operator(investigator.id, 'dispute_resolver');
    const dispute = await as(opener, 'POST', '/cases', { ...ACK, kind: 'dispute', subjectType: 'shuffle_entry', subjectId: c.entryIds[0], classification: 'allocation_dispute', summary: 'Participant disputes the finding.', relatedCaseId: c.caseId });
    expect(dispute.status, JSON.stringify(dispute)).toBe(201);
    expect((await as(investigator, 'POST', `/cases/${dispute.data.id}/start-review`, ACK)).status).toBe(200);
    const same = await as(investigator, 'POST', `/cases/${dispute.data.id}/decide`, { ...ACK, decision: 'overturned', reason: 'Same person as the fraud reviewer.' });
    expect(same.status).toBe(403); expect(same.error?.code).toBe('SEPARATION_OF_DUTIES');
    expect((await as(opener, 'POST', '/cases', { ...ACK, kind: 'fraud', subjectType: 'shuffle_entry', subjectId: '00000000-0000-4000-8000-0000000000aa', classification: 'other', summary: 's' })).status).toBe(404);
    expect((await as(opener, 'POST', '/cases', { ...ACK, kind: 'fraud', subjectType: 'shuffle_entry', subjectId: c.entryIds[0], classification: 'invented', summary: 's' })).status).toBe(400);
    const chain = await as(opener, 'GET', `/cases/${c.caseId}/chain`); expect(chain.data).toMatchObject({ chainOk: true }); expect(chain.data.events).toBeGreaterThanOrEqual(4);
  });

  it('TWO-PERSON override: requester != approver, evidence-bound, expiring, single-use, atomic; only two safe scopes exist', async () => {
    await f.operator(investigator.id, 'fraud_investigator'); await f.operator(resolver.id, 'dispute_resolver'); await f.operator(resolver2.id, 'dispute_resolver');
    const c = await shuffleCase(); await evidence(c.caseId); await reviewed(c);
    const body = { ...ACK, scope: 'cancel_entry_before_selection', targetId: c.entryIds[1], justification: 'Synthetic: confirmed duplicate account.', expiresAt: iso(3_600_000) };
    for (const bad of [{ scope: 'void_allocation' }, { scope: 'replace_selected_participant' }, { scope: 'rewrite_selection_evidence' }, { scope: 'unrestricted' }]) expect((await as(investigator, 'POST', `/cases/${c.caseId}/overrides`, { ...body, ...bad })).status, JSON.stringify(bad)).toBe(400);
    expect((await as(investigator, 'POST', `/cases/${c.caseId}/overrides`, { ...body, targetId: '00000000-0000-4000-8000-0000000000bb' })).error?.code).toBe('OVERRIDE_TARGET_INVALID');
    expect((await as(resolver, 'POST', `/cases/${c.caseId}/overrides`, body)).error?.code).toBe('OVERRIDE_NOT_ALLOWED'); // only an assigned fraud investigator may request
    const req = await as(investigator, 'POST', `/cases/${c.caseId}/overrides`, body); expect(req.status, JSON.stringify(req)).toBe(201);
    expect((await as(investigator, 'POST', `/cases/${c.caseId}/overrides`, body)).error?.code).toBe('OVERRIDE_ALREADY_OPEN');
    expect((await as(investigator, 'POST', `/overrides/${req.data.id}/execute`, ACK)).error?.code).toBe('TRANSITION_NOT_ALLOWED'); // not approved yet
    await f.operator(investigator.id, 'dispute_resolver');
    const self = await as(investigator, 'POST', `/overrides/${req.data.id}/approve`, ACK); // holds BOTH roles but is the requester
    expect(self.status).toBe(403); expect(self.error?.code).toBe('SEPARATION_OF_DUTIES');
    await expect(f.q(`UPDATE governance_overrides SET status = 'approved', approved_by_user_id = requested_by_user_id WHERE id = $1`, [req.data.id])).rejects.toThrow(/two_person|APPROVAL_NOT_ALLOWED/);
    expect((await as(opener, 'POST', `/overrides/${req.data.id}/approve`, ACK)).error?.code).toBe('SEPARATION_OF_DUTIES'); // not an assigned resolver
    // stale evidence: new evidence after the request invalidates the approval
    await evidence(c.caseId, 'Later evidence that the approver has not reviewed.');
    expect((await as(resolver, 'POST', `/overrides/${req.data.id}/approve`, ACK)).error?.code).toBe('OVERRIDE_EVIDENCE_STALE');
    expect((await as(investigator, 'POST', `/overrides/${req.data.id}/cancel`, { ...ACK, reason: 'Re-requesting on current evidence.' })).data.status).toBe('cancelled');
    const req2 = await as(investigator, 'POST', `/cases/${c.caseId}/overrides`, body); expect(req2.status).toBe(201);
    expect((await as(resolver, 'POST', `/overrides/${req2.data.id}/approve`, ACK)).data.status).toBe('approved');
    expect((await as(resolver2, 'POST', `/overrides/${req2.data.id}/approve`, ACK)).data.status).toBe('approved'); // idempotent, no second approver recorded
    expect((await f.q(`SELECT approved_by_user_id FROM governance_overrides WHERE id = $1`, [req2.data.id]))[0].approved_by_user_id).toBe(resolver.id);
    const ex = await as(resolver, 'POST', `/overrides/${req2.data.id}/execute`, ACK);
    expect(ex.status, JSON.stringify(ex)).toBe(200); expect(ex.data).toMatchObject({ status: 'executed', created: true });
    expect((await as(resolver, 'POST', `/overrides/${req2.data.id}/execute`, ACK)).data.created).toBe(false); // replay: single use
    const [e] = await f.q(`SELECT status, status_reason FROM shuffle_entries WHERE id = $1`, [c.entryIds[1]]);
    expect(e.status).toBe('cancelled'); expect(e.status_reason).toContain('override');
    expect((await f.q(`SELECT status FROM shuffle_entries WHERE id = $1`, [c.entryIds[0]]))[0].status).toBe('admitted'); // only the scoped target changed
    await expect(f.q(`UPDATE governance_overrides SET status = 'requested' WHERE id = $1`, [req2.data.id])).rejects.toThrow(/TRANSITION_NOT_ALLOWED/);
    expect((await as(opener, 'GET', `/cases/${c.caseId}/chain`)).data.chainOk).toBe(true);
  });

  it('expiry and atomicity: an expired approval cannot execute; an override that would rewrite a recorded selection fails and changes nothing', async () => {
    await f.operator(investigator.id, 'fraud_investigator'); await f.operator(resolver.id, 'dispute_resolver');
    const c = await shuffleCase(); await reviewed(c);
    const soon = await as(investigator, 'POST', `/cases/${c.caseId}/overrides`, { ...ACK, scope: 'cancel_entry_before_selection', targetId: c.entryIds[0], justification: 'Synthetic: short-lived request.', expiresAt: iso(1500) });
    expect(soon.status).toBe(201);
    await new Promise((r) => setTimeout(r, 1800));
    expect((await as(resolver, 'POST', `/overrides/${soon.data.id}/approve`, ACK)).error?.code).toBe('SEPARATION_OF_DUTIES'); // expired: refused
    expect((await as(resolver, 'POST', `/cases/${c.caseId}/expire-due`, ACK)).data.expired).toBe(1);
    expect((await f.q(`SELECT status FROM governance_overrides WHERE id = $1`, [soon.data.id]))[0].status).toBe('expired');
    // selection recorded -> cancelling an entry is a silent change to selection inputs: refused, the approved override stays approved, nothing changes
    await f.part.runSyntheticSelection(c.versionId, 1, f.ctx(creator.id));
    const locked = await as(investigator, 'POST', `/cases/${c.caseId}/overrides`, { ...ACK, scope: 'cancel_entry_before_selection', targetId: c.entryIds[1], justification: 'Synthetic: attempt after selection.', expiresAt: iso(3_600_000) });
    expect((await as(resolver, 'POST', `/overrides/${locked.data.id}/approve`, ACK)).status).toBe(200);
    const fail = await as(resolver, 'POST', `/overrides/${locked.data.id}/execute`, ACK);
    expect(fail.status).toBe(409); expect(fail.error?.code).toBe('ENTRY_LOCKED_AFTER_SELECTION');
    expect((await f.q(`SELECT status FROM governance_overrides WHERE id = $1`, [locked.data.id]))[0].status).toBe('approved'); // rolled back atomically
    expect((await f.q(`SELECT status FROM shuffle_entries WHERE id = $1`, [c.entryIds[1]]))[0].status).toBe('admitted');
    expect((await f.part.verifyEvidence(c.versionId))).toMatchObject({ chainOk: true, selectionOk: true });
  });

  it('Drops scope: only a RESERVED hold can be released by override; an allocated unit is never silently withdrawn', async () => {
    await f.operator(investigator.id, 'fraud_investigator'); await f.operator(resolver.id, 'dispute_resolver');
    const d = await f.dropScenario({ creatorId: creator.id, reviewerId: resolver.id, businessId: biz, ruleId: rule, quantity: 3, reserve: 2, allocate: 1 });
    const open = await as(opener, 'POST', '/cases', { ...ACK, kind: 'fraud', subjectType: 'drop_sponsorship', subjectId: d.sponsorshipId, classification: 'suspected_fabricated_evidence', summary: 'Synthetic drop case.' });
    expect(open.status).toBe(201); await as(investigator, 'POST', `/cases/${open.data.id}/start-review`, ACK);
    const mk = async (target: string) => (await as(investigator, 'POST', `/cases/${open.data.id}/overrides`, { ...ACK, scope: 'release_reserved_hold', targetId: target, justification: 'Synthetic: release this hold.', expiresAt: iso(3_600_000) })).data.id as string;
    const allocated = await mk(d.reservationIds[0]!); await as(resolver, 'POST', `/overrides/${allocated}/approve`, ACK);
    const bad = await as(resolver, 'POST', `/overrides/${allocated}/execute`, ACK);
    expect(bad.status).toBe(409); expect(bad.error?.code).toBe('RESERVATION_TRANSITION_NOT_ALLOWED');
    expect((await f.q(`SELECT status FROM drop_reservations WHERE id = $1`, [d.reservationIds[0]]))[0].status).toBe('allocated');
    const held = await mk(d.reservationIds[1]!); await as(resolver, 'POST', `/overrides/${held}/approve`, ACK);
    expect((await as(resolver, 'POST', `/overrides/${held}/execute`, ACK)).data.status).toBe('executed');
    expect((await f.q(`SELECT status FROM drop_reservations WHERE id = $1`, [d.reservationIds[1]]))[0].status).toBe('released');
    expect((await f.q(`SELECT reserved, allocated FROM drop_inventory WHERE sponsorship_id = $1`, [d.sponsorshipId]))[0]).toMatchObject({ reserved: 0, allocated: 1 });
    expect(await f.drops.verifyEvidence(d.sponsorshipId)).toMatchObject({ chainOk: true, inventoryConsistent: true });
    // a shuffle-scope override cannot be raised on a drops case
    expect((await as(investigator, 'POST', `/cases/${open.data.id}/overrides`, { ...ACK, scope: 'cancel_entry_before_selection', targetId: d.reservationIds[1], justification: 'Wrong family request.', expiresAt: iso(60_000) })).error?.code).toBe('OVERRIDE_SCOPE_INVALID');
  });

  it('case chain: nested tamper, removal and reorder are detected', async () => {
    await f.operator(investigator.id, 'fraud_investigator');
    const c = await shuffleCase(); await evidence(c.caseId); await reviewed(c);
    expect((await as(opener, 'GET', `/cases/${c.caseId}/chain`)).data).toMatchObject({ chainOk: true });
    await f.q(`ALTER TABLE governance_events DISABLE TRIGGER governance_events_append_only_trg`);
    try {
      await f.q(`UPDATE governance_events SET event = jsonb_set(event, '{classification}', '"other"') WHERE case_id = $1 AND seq = 1`, [c.caseId]);
      expect((await as(opener, 'GET', `/cases/${c.caseId}/chain`)).data.chainOk).toBe(false);
    } finally { await f.q(`ALTER TABLE governance_events ENABLE ALWAYS TRIGGER governance_events_append_only_trg`); }
  });
});
