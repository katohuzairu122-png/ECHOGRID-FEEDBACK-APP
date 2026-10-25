import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildDb } from '../../src/db/client';
import { DisputeError, PartnerCreditDisputeService, hasActiveDisputeHold } from '../../src/partner-credits/partner-credit-dispute.service';
import { createBenefitScratch } from './helpers/benefit-scratch';

/**
 * Split 07 disputed-award hold overlay on PostgreSQL (migration 0050), scratch database with forged award decisions. Real vest/expire/reserve enforcement
 * against real award flows is in partner-provisional-award-concurrency.integration.test.ts. No production, Neon or Stripe resource.
 */
describe.skipIf(!process.env.DATABASE_URL)('Split 07 dispute hold overlay (integration, scratch database)', () => {
  let s: Awaited<ReturnType<typeof createBenefitScratch>>;
  let svc: PartnerCreditDisputeService;
  let adminA: string; let adminB: string; let suspended: string; let member: string;
  let n = 0;
  const key = () => `k-${++n}-${crypto.randomUUID()}`;
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof DisputeError ? e.code : `other:${(e as { message?: string }).message}`));
  const open = (decisionId: string, actorId = adminA) => svc.open({ decisionId, actorId, evidenceRef: 'case-1', dedupeKey: key() });
  const state = async (disputeId: string) => (await s.rows<{ state: string; revision: number; plan: unknown }>('select state, revision, plan from partner_credit_award_disputes where id=$1', [disputeId]))[0]!;

  beforeAll(async () => {
    s = await createBenefitScratch('echogrid_s07_dispute');
    await s.disableDisputeGuards();
    [adminA, adminB, suspended, member] = [await s.makeUser('admin'), await s.makeUser('admin'), await s.makeUser('suspended_admin'), await s.makeUser('member')];
    svc = new PartnerCreditDisputeService(buildDb(await s.connect()));
  }, 300_000);
  afterAll(async () => { if (s) await s.close(); }, 120_000);

  it('is inert by default: with the guards enabled no dispute row can be written', async () => {
    // guards were disabled in beforeAll for the suite; prove the shipped default separately on a fresh scratch database
    const fresh = await createBenefitScratch('echogrid_s07_dispute_inert');
    try {
      const a = await fresh.makeUser('admin');
      const d = await fresh.makeDecision(fresh.tenantA, 'vested');
      const e = await new PartnerCreditDisputeService(buildDb(await fresh.connect())).open({ decisionId: d, actorId: a, evidenceRef: 'e', dedupeKey: 'k' }).then(() => null, (x: { message?: string; cause?: { message?: string } }) => x);
      expect(`${e?.message} ${e?.cause?.message}`).toMatch(/writes disabled pending financial activation/);
      expect((await fresh.rows('select count(*)::int n from partner_credit_award_disputes'))[0]!.n).toBe(0);
    } finally { await fresh.close(); }
  }, 300_000);

  it('only an ACTIVE platform administrator may act; suspended admins and ordinary members are refused everywhere', async () => {
    const d = await s.makeDecision(s.tenantA);
    for (const who of [suspended, member, crypto.randomUUID()]) expect(await code(open(d, who))).toBe('ACTOR_NOT_AUTHORIZED');
    const { disputeId } = await open(d);
    for (const who of [suspended, member]) {
      expect(await code(svc.addEvidence({ disputeId, actorId: who, evidenceRef: 'x', dedupeKey: key() }))).toBe('ACTOR_NOT_AUTHORIZED');
      expect(await code(svc.proposeRevocation({ disputeId, actorId: who }))).toBe('ACTOR_NOT_AUTHORIZED');
      expect(await code(svc.resolve({ disputeId, actorId: who, outcome: 'upheld', evidenceRef: 'x', dedupeKey: key() }))).toBe('ACTOR_NOT_AUTHORIZED');
    }
    expect((await state(disputeId)).state).toBe('open');
    // the database also refuses an actor snapshot that is not an admin
    await expect(s.admin.query("insert into partner_credit_dispute_events(dispute_id,business_id,kind,actor_id,actor_platform_role,evidence_ref,dedupe_key) values($1,$2,'evidence_added',$3,'member','e','role-x')", [disputeId, s.tenantA, member])).rejects.toMatchObject({ code: '23514' });
  });

  it('only provisional or vested awards can be disputed; missing awards are refused', async () => {
    expect(await code(open(await s.makeDecision(s.tenantA, 'reversed')))).toBe('AWARD_NOT_DISPUTABLE');
    expect(await code(open(await s.makeDecision(s.tenantA, 'ineligible')))).toBe('AWARD_NOT_DISPUTABLE');
    expect(await code(open(crypto.randomUUID()))).toBe('DECISION_NOT_FOUND');
    expect(await code(open(await s.makeDecision(s.tenantA, 'provisional')))).toBe('ok');
  });

  it('opening holds the award, is idempotent by key, and refuses a second open dispute', async () => {
    const d = await s.makeDecision(s.tenantA);
    const db = buildDb(await s.connect());
    expect(await hasActiveDisputeHold(db, d)).toBe(false);
    const k = key();
    const first = await svc.open({ decisionId: d, actorId: adminA, evidenceRef: 'e1', dedupeKey: k });
    expect(await svc.open({ decisionId: d, actorId: adminB, evidenceRef: 'e1', dedupeKey: k })).toEqual({ disputeId: first.disputeId, replay: true });
    expect(await code(open(d, adminB))).toBe('DISPUTE_ALREADY_OPEN');
    expect(await hasActiveDisputeHold(db, d)).toBe(true);
    expect((await s.rows('select count(*)::int n from partner_credit_award_disputes where decision_id=$1', [d]))[0]!.n).toBe(1);
  });

  it('upholding releases the hold without touching the award; the award can be disputed again later', async () => {
    const d = await s.makeDecision(s.tenantA);
    const db = buildDb(await s.connect());
    const { disputeId } = await open(d);
    await svc.addEvidence({ disputeId, actorId: adminB, evidenceRef: 'more-evidence', dedupeKey: key() });
    const rk = key();
    expect(await svc.resolve({ disputeId, actorId: adminB, outcome: 'upheld', evidenceRef: 'review-ok', dedupeKey: rk })).toEqual({ state: 'released', replay: false });
    expect(await svc.resolve({ disputeId, actorId: adminB, outcome: 'upheld', evidenceRef: 'review-ok', dedupeKey: rk })).toEqual({ state: 'released', replay: true });
    expect(await hasActiveDisputeHold(db, d)).toBe(false);
    expect(await state(disputeId)).toMatchObject({ state: 'released', revision: 2, plan: null });
    expect((await s.rows<{ state: string }>('select state from partner_credit_award_decisions where id=$1', [d]))[0]!.state).toBe('vested'); // award untouched
    expect(await code(svc.addEvidence({ disputeId, actorId: adminA, evidenceRef: 'late', dedupeKey: key() }))).toBe('DISPUTE_NOT_OPEN');
    expect(await code(open(d))).toBe('ok'); // a new dispute may follow a released one
    expect((await s.rows<{ kind: string }>('select kind from partner_credit_dispute_events where dispute_id=$1 order by seq', [disputeId])).map(r => r.kind)).toEqual(['opened', 'evidence_added', 'resolved_upheld']);
  });

  it('revocation needs DUAL control: a different administrator approves; self-approval is refused by the service AND the database; the hold stays and only a plan is recorded', async () => {
    const d = await s.makeDecision(s.tenantA);
    const db = buildDb(await s.connect());
    const { disputeId } = await open(d, adminA);
    expect(await code(svc.resolve({ disputeId, actorId: adminA, outcome: 'revoked', evidenceRef: 'x', dedupeKey: key() }))).toBe('DUAL_APPROVAL_REQUIRED'); // nothing proposed
    const { correctionId } = await svc.proposeRevocation({ disputeId, actorId: adminA });
    expect(await svc.proposeRevocation({ disputeId, actorId: adminA })).toMatchObject({ correctionId, replay: true });
    expect(await code(svc.proposeRevocation({ disputeId, actorId: adminB }))).toBe('CORRECTION_ALREADY_EXISTS');
    expect(await code(svc.resolve({ disputeId, actorId: adminA, outcome: 'upheld', evidenceRef: 'x', dedupeKey: key() }))).toBe('CORRECTION_PENDING');
    expect(await code(svc.resolve({ disputeId, actorId: adminB, outcome: 'revoked', evidenceRef: 'x', dedupeKey: key() }))).toBe('DUAL_APPROVAL_REQUIRED'); // proposed, not approved
    expect(await code(svc.decideCorrection({ correctionId, actorId: adminA, approve: true }))).toBe('SELF_APPROVAL');
    await expect(s.admin.query("update partner_credit_corrections set state='approved', decided_by=proposed_by, decided_at=now() where id=$1", [correctionId])).rejects.toMatchObject({ code: '23514', constraint: 'partner_credit_corrections_no_self_approval' });
    expect(await code(svc.decideCorrection({ correctionId, actorId: suspended, approve: true }))).toBe('ACTOR_NOT_AUTHORIZED');
    expect(await svc.decideCorrection({ correctionId, actorId: adminB, approve: true, note: 'confirmed' })).toEqual({ state: 'approved' });
    expect(await code(svc.decideCorrection({ correctionId, actorId: adminB, approve: false }))).toBe('CORRECTION_NOT_PROPOSED');
    expect(await svc.resolve({ disputeId, actorId: adminA, outcome: 'revoked', evidenceRef: 'final', dedupeKey: key() })).toEqual({ state: 'revoked', replay: false });
    expect(await state(disputeId)).toMatchObject({ state: 'revoked', plan: { type: 'revoke_award', decisionId: d, units: 1, correctionId, executed: false } });
    expect(await hasActiveDisputeHold(db, d)).toBe(true); // still held until an authorized executor acts
    expect((await s.rows<{ state: string }>('select state from partner_credit_award_decisions where id=$1', [d]))[0]!.state).toBe('vested'); // no ledger/award mutation here
    expect((await s.rows('select count(*)::int n from partner_credit_ledger'))[0]!.n).toBe(0);
  });

  it('a rejected correction cannot support a revocation, and the dispute can still be upheld', async () => {
    const d = await s.makeDecision(s.tenantA);
    const { disputeId } = await open(d);
    const { correctionId } = await svc.proposeRevocation({ disputeId, actorId: adminA });
    expect(await svc.decideCorrection({ correctionId, actorId: adminB, approve: false })).toEqual({ state: 'rejected' });
    expect(await code(svc.resolve({ disputeId, actorId: adminB, outcome: 'revoked', evidenceRef: 'x', dedupeKey: key() }))).toBe('DUAL_APPROVAL_REQUIRED');
    expect(await svc.resolve({ disputeId, actorId: adminB, outcome: 'upheld', evidenceRef: 'ok', dedupeKey: key() })).toMatchObject({ state: 'released' });
  });

  it('concurrency: simultaneous opens create one dispute; simultaneous resolutions resolve once; a self-approval race never approves', async () => {
    const d = await s.makeDecision(s.tenantA);
    const svcs = await Promise.all(Array.from({ length: 6 }, async () => new PartnerCreditDisputeService(buildDb(await s.connect()))));
    const opens = await Promise.all(svcs.map(x => code(x.open({ decisionId: d, actorId: adminA, evidenceRef: 'c', dedupeKey: key() }))));
    expect(opens.filter(c => c === 'ok')).toHaveLength(1);
    expect(opens.filter(c => c === 'DISPUTE_ALREADY_OPEN')).toHaveLength(5);
    const disputeId = (await s.rows<{ id: string }>("select id from partner_credit_award_disputes where decision_id=$1 and state='open'", [d]))[0]!.id;
    const resolves = await Promise.all(svcs.map((x, i) => code(x.resolve({ disputeId, actorId: i % 2 ? adminA : adminB, outcome: 'upheld', evidenceRef: 'r', dedupeKey: key() }))));
    expect(resolves.filter(c => c === 'ok')).toHaveLength(1);
    expect(resolves.filter(c => c === 'DISPUTE_NOT_OPEN')).toHaveLength(5);
    expect((await state(disputeId)).revision).toBe(2);
    expect((await s.rows('select count(*)::int n from partner_credit_dispute_events where dispute_id=$1 and kind=\'resolved_upheld\'', [disputeId]))[0]!.n).toBe(1);

    const d2 = await s.makeDecision(s.tenantA);
    const { disputeId: d2id } = await open(d2);
    const { correctionId } = await svc.proposeRevocation({ disputeId: d2id, actorId: adminA });
    const race = await Promise.all(svcs.map((x, i) => code(x.decideCorrection({ correctionId, actorId: i < 3 ? adminA : adminB, approve: true }))));
    expect(race.slice(0, 3).every(c => c === 'SELF_APPROVAL' || c === 'CORRECTION_NOT_PROPOSED')).toBe(true); // the proposer never gets an 'ok', whichever check fires first
    expect(race.filter(c => c === 'ok')).toHaveLength(1);
    expect(race.slice(3).filter(c => c === 'ok')).toHaveLength(1);
    expect((await s.rows<{ decided_by: string }>('select decided_by from partner_credit_corrections where id=$1', [correctionId]))[0]!.decided_by).toBe(adminB);
  });

  it('tenant keys are database-enforced and evidence, resolutions and decisions are immutable', async () => {
    const d = await s.makeDecision(s.tenantA);
    await expect(s.admin.query('insert into partner_credit_award_disputes(business_id,decision_id) values($1,$2)', [s.tenantB, d])).rejects.toMatchObject({ code: '23503', constraint: 'partner_credit_award_disputes_decision_business_fk' });
    const { disputeId } = await open(d);
    await expect(s.admin.query("insert into partner_credit_dispute_events(dispute_id,business_id,kind,actor_id,actor_platform_role,evidence_ref,dedupe_key) values($1,$2,'evidence_added',$3,'admin','e','tenant-x')", [disputeId, s.tenantB, adminA])).rejects.toMatchObject({ code: '23503' });
    for (const sql of ['update partner_credit_dispute_events set note=\'x\'', 'delete from partner_credit_dispute_events', 'truncate partner_credit_dispute_events', 'delete from partner_credit_award_disputes', 'truncate partner_credit_award_disputes', 'delete from partner_credit_corrections']) {
      await expect(s.admin.query(sql)).rejects.toBeDefined();
    }
    await svc.resolve({ disputeId, actorId: adminA, outcome: 'upheld', evidenceRef: 'ok', dedupeKey: key() });
    await expect(s.admin.query("update partner_credit_award_disputes set state='open', resolved_at=null where id=$1", [disputeId])).rejects.toThrow(/already resolved/);
    await expect(s.admin.query("update partner_credit_award_disputes set decision_id=gen_random_uuid() where id=$1", [(await s.rows<{ id: string }>('select id from partner_credit_award_disputes where state=\'open\' limit 1'))[0]!.id])).rejects.toBeDefined();
    await expect(s.admin.query("insert into partner_credit_award_disputes(business_id,decision_id,state,resolved_at) values($1,$2,'revoked',now())", [s.tenantA, d])).rejects.toMatchObject({ code: '23514', constraint: 'partner_credit_award_disputes_shape_check' }); // revoked needs a plan
  });
});
