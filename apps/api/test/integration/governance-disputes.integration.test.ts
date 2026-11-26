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

/** TSH-08 (completion): duplicate-dispute prevention, fraud signals, concurrency and replay of overrides, chain integrity, historical preservation, authorization. Synthetic data only. */
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


describe.skipIf(!databaseUrl)('TSH-08 governance completion (real HTTP, real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>;
  let creator: { id: string; token: string }; let opener: { id: string; token: string }; let investigator: { id: string; token: string }; let resolver: { id: string; token: string }; let resolver2: { id: string; token: string }; let plain: { id: string; token: string };
  let biz: string; let rule: string;
  const as = (u: { token: string }, m: string, p: string, body?: unknown, flags?: Flags) => http(m, p, { token: u.token, body, flags });
  const open = (u: { token: string }, subjectType: string, subjectId: string, kind = 'fraud', classification = 'suspected_duplicate_participation') => as(u, 'POST', '/cases', { ...ACK, kind, subjectType, subjectId, classification, summary: 'Synthetic governance case.' });
  const caseFor = async (entries = 2) => { const s = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries }); const r = await open(opener, 'shuffle_entry', s.entryIds[0]!); return { ...s, caseId: r.data.id as string }; };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client);
    creator = await f.user('gc-creator'); opener = await f.user('gc-opener'); investigator = await f.user('gc-investigator'); resolver = await f.user('gc-resolver'); resolver2 = await f.user('gc-resolver2'); plain = await f.user('gc-plain', false);
    biz = await f.business('gc');
    await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`);
    rule = await f.rule(creator.id);
    await f.q(`UPDATE governance_operators SET active = false`);
    await f.operator(investigator.id, 'fraud_investigator'); await f.operator(resolver.id, 'dispute_resolver'); await f.operator(resolver2.id, 'dispute_resolver');
  });
  afterAll(async () => { await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`).catch(() => undefined); await f.q(`UPDATE governance_operators SET active = false`).catch(() => undefined); await client?.end(); });

  it('DUPLICATE PREVENTION: one not-closed case per kind and subject (idempotent open, concurrency-safe, DB backstop); a closed case allows a new one; fraud and dispute are separate kinds', async () => {
    const s = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries: 1 }); const entry = s.entryIds[0]!;
    const a = await open(opener, 'shuffle_entry', entry); expect(a.status).toBe(201); expect(a.data.created).toBe(true);
    const b = await open(investigator, 'shuffle_entry', entry); expect(b.status).toBe(200); expect(b.data).toMatchObject({ id: a.data.id, created: false });
    const d = await open(opener, 'shuffle_entry', entry, 'dispute', 'allocation_dispute'); expect(d.status).toBe(201); expect(d.data.id).not.toBe(a.data.id);
    const s2 = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries: 1 });
    const racers = await Promise.all([0, 1, 2, 3, 4].map(() => open(opener, 'shuffle_entry', s2.entryIds[0]!)));
    expect(racers.filter((r) => r.data.created === true)).toHaveLength(1); expect(new Set(racers.map((r) => r.data.id)).size).toBe(1);
    expect(await f.q(`SELECT 1 FROM governance_cases WHERE subject_id = $1 AND kind = 'fraud'`, [s2.entryIds[0]])).toHaveLength(1);
    await expect(f.q(`INSERT INTO governance_cases (kind, subject_type, subject_id, campaign_version_id, classification, summary, opened_by_user_id) VALUES ('fraud','shuffle_entry',$1,$2,'other','dup',$3)`, [entry, s.versionId, opener.id])).rejects.toThrow(/governance_cases_one_open_uq|duplicate/i);
    // lifecycle to closed, then a NEW case is allowed (history preserved: the old case is still there)
    await as(investigator, 'POST', `/cases/${a.data.id}/start-review`, ACK);
    await as(investigator, 'POST', `/cases/${a.data.id}/decide`, { ...ACK, decision: 'no_action', reason: 'Nothing found in the synthetic data.' });
    await as(opener, 'POST', `/cases/${a.data.id}/close`, ACK);
    const again = await open(opener, 'shuffle_entry', entry); expect(again.status).toBe(201); expect(again.data.id).not.toBe(a.data.id);
    const old = await as(opener, 'GET', `/cases/${a.data.id}`); expect(old.data.case).toMatchObject({ status: 'closed', decision: 'no_action' });
    for (const bad of ['invented', 'penalize_customer']) expect((await open(opener, 'shuffle_entry', entry, 'fraud', bad)).status).toBe(400);
  });

  it('authorization: anonymous 401, an authenticated NON-platform user 403 on every route (cases, signals, from-signal), cashier denied, no cross-feature leakage', async () => {
    const id = '00000000-0000-4000-8000-000000000009';
    const routes: [string, string][] = [['GET', `/cases/${id}`], ['POST', '/cases'], ['POST', '/cases/from-signal'], ['GET', `/signals/shuffle/${id}`], ['GET', `/signals/sponsorship/${id}`], ['GET', '/signals/referrals'], ['POST', `/cases/${id}/decide`], ['POST', `/overrides/${id}/approve`], ['POST', `/overrides/${id}/execute`]];
    for (const [m, p] of routes) {
      expect((await http(m, p, { body: m === 'POST' ? ACK : undefined })).status, `anon ${m} ${p}`).toBe(401);
      expect((await as(plain, m, p, m === 'POST' ? ACK : undefined)).status, `plain ${m} ${p}`).toBe(403);
    }
    const cashier = await signCashierAccessToken(opener.id, SECRET, { sessionId: '00000000-0000-4000-8000-0000000000a1', businessId: '00000000-0000-4000-8000-0000000000a2' });
    for (const [m, p] of routes) { const r = await http(m, p, { token: cashier, body: m === 'POST' ? ACK : undefined }); expect(r.status, `cashier ${m} ${p}`).toBe(403); expect(r.error?.code).toBe('CASHIER_ROUTE_DENIED'); }
    expect((await as(opener, 'GET', `/signals/shuffle/${id}`, undefined, { drops: 'true' })).status).toBe(404); // shuffle scan needs the Shuffle control
    expect((await as(opener, 'GET', `/signals/sponsorship/${id}`, undefined, { shuffle: 'true' })).status).toBe(404); // sponsorship scan needs the Drops control
    expect((await as(opener, 'GET', '/signals/referrals', undefined, {})).status).toBe(404); // neither control on
  });

  it('FRAUD SIGNALS: clean data yields none; tampered evidence is detected (read-only, no thresholds, no automatic action); unsupported signals are unavailable, not clean', async () => {
    const s = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries: 3, min: 1 });
    const clean = await as(opener, 'GET', `/signals/shuffle/${s.versionId}`); expect(clean.status).toBe(200); expect(clean.data.signals).toEqual([]);
    expect(Object.keys(clean.data.unavailable).sort()).toEqual(['duplicate_participation_across_identities', 'suspicious_repeated_collection_attempts', 'unauthorized_account_activity']);
    // (1) fabricated/replayed evidence: a snapshot that cites ANOTHER customer's purchase event
    const other = await f.customer({ businessId: biz, purchase: true }); const victim = s.customers[0]!;
    const [victimPurchase] = await f.q(`SELECT id FROM loyalty_purchase_events WHERE customer_id = $1 LIMIT 1`, [victim]);
    const forged = await f.customer();
    await f.q(`INSERT INTO shuffle_eligibility_snapshots (campaign_version_id, customer_id, qualified, evidence, evidence_hash, rule_version_id) VALUES ($1,$2,true,$3,repeat('a',64),$4)`, [s.versionId, forged, JSON.stringify({ evidenceIds: [victimPurchase.id] }), rule]);
    void other;
    // (2) an admitted entry whose snapshot is not qualified (tampered snapshot, trigger disabled in the disposable DB)
    await f.q(`ALTER TABLE shuffle_eligibility_snapshots DISABLE TRIGGER shuffle_snapshots_append_only_trg`);
    try { await f.q(`UPDATE shuffle_eligibility_snapshots SET qualified = false WHERE campaign_version_id = $1 AND customer_id = $2`, [s.versionId, s.customers[1]]); } finally { await f.q(`ALTER TABLE shuffle_eligibility_snapshots ENABLE ALWAYS TRIGGER shuffle_snapshots_append_only_trg`); }
    // (3) a tampered evidence chain event
    await f.q(`ALTER TABLE shuffle_allocation_events DISABLE TRIGGER shuffle_alloc_events_append_only_trg`);
    try { await f.q(`UPDATE shuffle_allocation_events SET event = jsonb_set(event, '{invitationId}', '"tampered"') WHERE campaign_version_id = $1 AND seq = 1`, [s.versionId]); } finally { await f.q(`ALTER TABLE shuffle_allocation_events ENABLE ALWAYS TRIGGER shuffle_alloc_events_append_only_trg`); }
    const dirty = await as(opener, 'GET', `/signals/shuffle/${s.versionId}`); const codes = (dirty.data.signals as { code: string }[]).map((x) => x.code).sort();
    expect(codes).toEqual(['admitted_without_eligibility', 'evidence_chain_broken', 'evidence_customer_mismatch']);
    for (const sg of dirty.data.signals) { expect(sg.key).toMatch(/^[0-9a-f]{64}$/); expect(JSON.stringify(sg)).not.toMatch(/penal|ban|block|suspend/i); }
    // read-only: detection changed nothing
    expect((await f.q(`SELECT status FROM shuffle_entries WHERE campaign_version_id = $1 AND status = 'admitted'`, [s.versionId]))).toHaveLength(3);
    // a signal opens a FRAUD case only through the server re-detecting it; a forged key is refused; the signal is stored as reference evidence; no penalty follows
    const sig = (dirty.data.signals as { key: string; code: string; classification: string }[]).find((x) => x.code === 'admitted_without_eligibility')!;
    const body = { ...ACK, scope: { type: 'shuffle_version', id: s.versionId }, signalKey: sig.key, subjectType: 'shuffle_entry', subjectId: s.entryIds[1] };
    expect((await as(opener, 'POST', '/cases/from-signal', { ...body, signalKey: 'f'.repeat(64) })).error?.code).toBe('SIGNAL_NOT_PRESENT');
    const made = await as(opener, 'POST', '/cases/from-signal', body); expect(made.status, JSON.stringify(made)).toBe(201);
    const again = await as(opener, 'POST', '/cases/from-signal', body); expect(again.status).toBe(200); expect(again.data.id).toBe(made.data.id);
    const detail = await as(opener, 'GET', `/cases/${made.data.id}`);
    expect(detail.data.case).toMatchObject({ kind: 'fraud', classification: 'suspected_qualification_manipulation', status: 'open' }); expect(detail.data.evidence).toHaveLength(1);
    expect((await f.q(`SELECT status FROM shuffle_entries WHERE id = $1`, [s.entryIds[1]]))[0].status).toBe('admitted'); // no automatic penalty or withdrawal
  });

  it('Drops signals: inventory manipulation and selection replay mismatch are detected; self-referral and referral cycles are exact comparisons', async () => {
    const d = await f.dropScenario({ creatorId: creator.id, reviewerId: resolver.id, businessId: biz, ruleId: rule, quantity: 3, reserve: 2, allocate: 1 });
    expect((await as(opener, 'GET', `/signals/sponsorship/${d.sponsorshipId}`)).data.signals).toEqual([]);
    await f.q(`ALTER TABLE drop_inventory DISABLE TRIGGER drop_inventory_guard_trg`);
    try { await f.q(`UPDATE drop_inventory SET reserved = 0 WHERE sponsorship_id = $1`, [d.sponsorshipId]); } finally { await f.q(`ALTER TABLE drop_inventory ENABLE ALWAYS TRIGGER drop_inventory_guard_trg`); }
    const sig = (await as(opener, 'GET', `/signals/sponsorship/${d.sponsorshipId}`)).data.signals as { code: string; classification: string }[];
    expect(sig.map((x) => x.code)).toContain('inventory_inconsistent'); expect(sig.find((x) => x.code === 'inventory_inconsistent')?.classification).toBe('suspected_inventory_manipulation');
    // selection replay mismatch
    const s = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries: 3, min: 1 }); await f.part.runSyntheticSelection(s.versionId, 2, f.ctx(creator.id));
    const [orig] = await f.q(`SELECT selected_entry_ids FROM shuffle_selection_results WHERE campaign_version_id = $1`, [s.versionId]);
    const notSelected = s.entryIds.find((id) => !(orig.selected_entry_ids as string[]).includes(id))!;
    await f.q(`ALTER TABLE shuffle_selection_results DISABLE TRIGGER shuffle_selection_append_only_trg`);
    try { await f.q(`UPDATE shuffle_selection_results SET selected_entry_ids = $2::jsonb WHERE campaign_version_id = $1`, [s.versionId, JSON.stringify([notSelected, (orig.selected_entry_ids as string[])[0]])]); } finally { await f.q(`ALTER TABLE shuffle_selection_results ENABLE ALWAYS TRIGGER shuffle_selection_append_only_trg`); }
    const ssig = (await as(opener, 'GET', `/signals/shuffle/${s.versionId}`)).data.signals as { code: string }[];
    expect(ssig.map((x) => x.code)).toContain('selection_replay_mismatch');
    // referrals: a cycle between two customers (and a self referral if the database allows one)
    const a = await f.customer(); const b = await f.customer();
    const ins = (refing: string, refd: string) => f.q(`INSERT INTO customer_referrals (referral_type, referring_customer_id, referred_customer_id, provenance_kind, provenance_ref) VALUES ('customer_referral',$1,$2,'customer_referral_token',$3)`, [refing, refd, `ref-${refing}-${refd}`]);
    let cycleInserted = true; try { await ins(a, b); await ins(b, a); } catch { cycleInserted = false; }
    const self = await f.customer(); let selfInserted = true; try { await ins(self, self); } catch { selfInserted = false; }
    const refSig = (await as(opener, 'GET', '/signals/referrals')).data.signals as { code: string; refs: string[] }[];
    if (cycleInserted) expect(refSig.some((x) => x.code === 'referral_cycle')).toBe(true); else expect(refSig.some((x) => x.code === 'referral_cycle')).toBe(false); // the database already prevents it
    if (selfInserted) expect(refSig.some((x) => x.code === 'self_referral')).toBe(true); else expect(refSig.some((x) => x.code === 'self_referral')).toBe(false);
  });

  it('CONCURRENCY and REPLAY: two resolvers approving at once record ONE approver; parallel execution applies the action once; replays and late approvals are refused', async () => {
    const c = await caseFor(3); await as(investigator, 'POST', `/cases/${c.caseId}/start-review`, ACK);
    const mk = async (target: string) => (await as(investigator, 'POST', `/cases/${c.caseId}/overrides`, { ...ACK, scope: 'cancel_entry_before_selection', targetId: target, justification: 'Synthetic: confirmed duplicate account.', expiresAt: iso(3_600_000) })).data.id as string;
    const ov = await mk(c.entryIds[1]!);
    const approvals = await Promise.all([as(resolver, 'POST', `/overrides/${ov}/approve`, ACK), as(resolver2, 'POST', `/overrides/${ov}/approve`, ACK), as(resolver, 'POST', `/overrides/${ov}/approve`, ACK)]);
    expect(approvals.every((r) => r.status === 200 && r.data.status === 'approved')).toBe(true);
    const [row] = await f.q(`SELECT approved_by_user_id FROM governance_overrides WHERE id = $1`, [ov]); expect([resolver.id, resolver2.id]).toContain(row.approved_by_user_id);
    expect((await f.q(`SELECT 1 FROM governance_events WHERE case_id = $1 AND event->>'type' = 'override_approved'`, [c.caseId]))).toHaveLength(1); // exactly one approval recorded on the chain
    const execs = await Promise.all([1, 2, 3].map(() => as(resolver, 'POST', `/overrides/${ov}/execute`, ACK)));
    expect(execs.every((r) => r.status === 200)).toBe(true); expect(execs.filter((r) => r.data.created === true)).toHaveLength(1);
    expect((await f.q(`SELECT 1 FROM governance_events WHERE case_id = $1 AND event->>'type' = 'override_executed'`, [c.caseId]))).toHaveLength(1);
    expect((await f.q(`SELECT 1 FROM shuffle_allocation_events WHERE campaign_version_id = $1 AND event->>'type' = 'entry_cancelled'`, [c.versionId]))).toHaveLength(1); // the action ran once
    // replay and late actions on a finished override are refused
    expect((await as(resolver2, 'POST', `/overrides/${ov}/approve`, ACK)).error?.code).toBe('TRANSITION_NOT_ALLOWED');
    expect((await as(investigator, 'POST', `/overrides/${ov}/cancel`, { ...ACK, reason: 'Trying to undo an executed override.' })).error?.code).toBe('TRANSITION_NOT_ALLOWED');
    await expect(f.q(`UPDATE governance_overrides SET status = 'approved' WHERE id = $1`, [ov])).rejects.toThrow(/TRANSITION_NOT_ALLOWED/);
    // a rejected override can never be executed; a new request for the same target after execution is a different (open) override only while none is open
    const ov2 = await mk(c.entryIds[2]!);
    expect((await as(resolver, 'POST', `/overrides/${ov2}/reject`, { ...ACK, reason: 'Evidence does not support this action.' })).data.status).toBe('rejected');
    expect((await as(resolver, 'POST', `/overrides/${ov2}/execute`, ACK)).error?.code).toBe('TRANSITION_NOT_ALLOWED');
    expect((await as(resolver, 'POST', `/overrides/${ov2}/approve`, ACK)).error?.code).toBe('TRANSITION_NOT_ALLOWED');
    // an invalid override: a target that is not part of the case campaign
    const other = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries: 1 });
    expect((await as(investigator, 'POST', `/cases/${c.caseId}/overrides`, { ...ACK, scope: 'cancel_entry_before_selection', targetId: other.entryIds[0], justification: 'Synthetic: wrong campaign target.', expiresAt: iso(60_000) })).error?.code).toBe('OVERRIDE_TARGET_INVALID');
  });

  it('CHAIN INTEGRITY and HISTORICAL PRESERVATION: nested tamper, reorder and removal are detected; decisions, evidence and referenced customers are preserved', async () => {
    const c = await caseFor(2); await as(opener, 'POST', `/cases/${c.caseId}/evidence`, { ...ACK, kind: 'note', body: 'Synthetic evidence for integrity tests.' });
    await as(investigator, 'POST', `/cases/${c.caseId}/start-review`, ACK);
    await as(investigator, 'POST', `/cases/${c.caseId}/decide`, { ...ACK, decision: 'upheld', reason: 'Evidence supports the finding in this synthetic case.' });
    expect((await as(opener, 'GET', `/cases/${c.caseId}/chain`)).data).toMatchObject({ chainOk: true, events: 4 });
    const swap = async (mut: string) => { await f.q(`ALTER TABLE governance_events DISABLE TRIGGER governance_events_append_only_trg`); try { await f.q(mut, [c.caseId]); } finally { await f.q(`ALTER TABLE governance_events ENABLE ALWAYS TRIGGER governance_events_append_only_trg`); } };
    const snapshot = await f.q(`SELECT id, seq, prev_hash, hash, event FROM governance_events WHERE case_id = $1 ORDER BY seq`, [c.caseId]);
    // reorder: swap the positions of events 2 and 3 (through a temporary sequence value, because (case, seq) is unique)
    const reorder = async () => { await f.q(`ALTER TABLE governance_events DISABLE TRIGGER governance_events_append_only_trg`); try { await f.q(`UPDATE governance_events SET seq = 99 WHERE case_id = $1 AND seq = 2`, [c.caseId]); await f.q(`UPDATE governance_events SET seq = 2 WHERE case_id = $1 AND seq = 3`, [c.caseId]); await f.q(`UPDATE governance_events SET seq = 3 WHERE case_id = $1 AND seq = 99`, [c.caseId]); } finally { await f.q(`ALTER TABLE governance_events ENABLE ALWAYS TRIGGER governance_events_append_only_trg`); } };
    await reorder();
    expect((await as(opener, 'GET', `/cases/${c.caseId}/chain`)).data.chainOk).toBe(false);
    await reorder();
    expect((await as(opener, 'GET', `/cases/${c.caseId}/chain`)).data.chainOk).toBe(true); // restored: verification is reproducible
    // nested tamper in the evidence-submitted event, then removal of an event
    await swap(`UPDATE governance_events SET event = jsonb_set(event, '{contentHash}', '"x"') WHERE case_id = $1 AND event->>'type' = 'evidence_submitted'`);
    expect((await as(opener, 'GET', `/cases/${c.caseId}/chain`)).data.chainOk).toBe(false);
    await f.q(`ALTER TABLE governance_events DISABLE TRIGGER governance_events_append_only_trg`);
    try { await f.q(`UPDATE governance_events SET event = $2::jsonb WHERE id = $1`, [snapshot[1]!.id, JSON.stringify(snapshot[1]!.event)]); await f.q(`DELETE FROM governance_events WHERE case_id = $1 AND seq = 3`, [c.caseId]); } finally { await f.q(`ALTER TABLE governance_events ENABLE ALWAYS TRIGGER governance_events_append_only_trg`); }
    expect((await as(opener, 'GET', `/cases/${c.caseId}/chain`)).data.chainOk).toBe(false); // an event was removed
    // historical preservation: the decision and evidence are intact, the entry and its customer cannot be deleted
    const d = await as(opener, 'GET', `/cases/${c.caseId}`); expect(d.data.case).toMatchObject({ status: 'decided', decision: 'upheld' }); expect(d.data.evidence).toHaveLength(1);
    await expect(f.q(`DELETE FROM customers WHERE id = $1`, [c.customers[0]])).rejects.toThrow(/foreign key|violates/i);
    await expect(f.q(`DELETE FROM shuffle_entries WHERE id = $1`, [c.entryIds[0]])).rejects.toThrow(/IMMUTABLE/);
  });
});
