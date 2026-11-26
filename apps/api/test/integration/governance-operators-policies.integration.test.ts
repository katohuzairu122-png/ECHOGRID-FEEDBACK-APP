import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import { GovernanceService } from '../../src/governance/governance.service';
import { GovernanceOperatorService } from '../../src/governance/governance-operator.service';
import { GovernanceDecisionPolicyService } from '../../src/governance/governance-policy.service';
import { makeFixtures, tag } from './helpers/tentaship-fixtures';

/** G5 against real PostgreSQL: operator-assignment lifecycle (scope, expiry, revocation, audit) and immutable decision policies. Synthetic users and policies only; production stays empty. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');

/** Runs assertions inside a drizzle transaction that is ALWAYS rolled back (services nest as savepoints), so a test can retire policies without touching the shared state. */
async function rolledBackIn(db: Db, fn: (tx: Db) => Promise<void>) {
  class Rollback extends Error {}
  await db.transaction(async (tx) => { await fn(tx as unknown as Db); throw new Rollback(); }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
}

describe.skipIf(!databaseUrl)('G5 operator assignments and decision policies (real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>; let owner: { id: string }; let owner2: { id: string }; let opener: { id: string }; let creator: { id: string };
  let biz: string; let rule: string; let ops: GovernanceOperatorService; let gov: GovernanceService;
  const ON = { shuffle: true, drops: true };
  const rolledBack = (fn: (tx: Db) => Promise<void>) => rolledBackIn(f.db, fn);
  const shuffleCase = async () => {
    const s = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries: 1 });
    return gov.openCase({ kind: 'fraud', subjectType: 'shuffle_entry', subjectId: s.entryIds[0]!, classification: 'suspected_duplicate_participation', summary: 'Synthetic governance case.' }, f.ctx(opener.id));
  };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client);
    owner = await f.user('g5-owner', false); owner2 = await f.user('g5-owner2', false); opener = await f.user('g5-opener'); creator = await f.user('g5-creator');
    biz = await f.business('g5'); rule = await f.rule(creator.id); await f.ensurePolicies();
    ops = new GovernanceOperatorService(f.db); gov = new GovernanceService(f.db, ON);
  });
  afterAll(async () => { await client?.end(); });

  it('ASSIGNMENT LIFECYCLE: assigned by a different person, one current assignment per role, revocation is final and audited, history is append-only', async () => {
    const u = await f.user('g5-op1', false);
    await expect(ops.assign({ userId: u.id, role: 'fraud_investigator' }, f.ctx(u.id))).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' });
    const a = await ops.assign({ userId: u.id, role: 'fraud_investigator', scope: 'shuffle' }, f.ctx(owner.id));
    expect(a.scope).toBe('shuffle'); expect(a.assignedByUserId).toBe(owner.id);
    await expect(ops.assign({ userId: u.id, role: 'fraud_investigator' }, f.ctx(owner.id))).rejects.toMatchObject({ code: 'ASSIGNMENT_EXISTS' });
    await expect(ops.revoke(a.id, 'short', f.ctx(owner.id))).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    expect(await ops.isEffective(u.id, 'fraud_investigator', 'shuffle')).toBe(true);
    expect(await ops.isEffective(u.id, 'fraud_investigator', 'drops')).toBe(false); // scope
    expect(await ops.isEffective(u.id, 'dispute_resolver', 'shuffle')).toBe(false); // role
    const r = await ops.revoke(a.id, 'Synthetic revocation for the test.', f.ctx(owner2.id));
    expect(r.active).toBe(false); expect(r.revokedByUserId).toBe(owner2.id);
    expect(await ops.isEffective(u.id, 'fraud_investigator', 'shuffle')).toBe(false);
    await expect(ops.revoke(a.id, 'Second revocation attempt.', f.ctx(owner.id))).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_CURRENT' });
    // the revoked row is final: no re-activation, no edit, no delete
    await expect(f.q(`UPDATE governance_operators SET active = true, revoked_at = NULL, revoked_by_user_id = NULL, revocation_reason = NULL WHERE id = $1`, [a.id])).rejects.toThrow(/IMMUTABLE/);
    await expect(f.q(`UPDATE governance_operators SET scope = 'both' WHERE id = $1`, [a.id])).rejects.toThrow(/IMMUTABLE/);
    await expect(f.q(`DELETE FROM governance_operators WHERE id = $1`, [a.id])).rejects.toThrow(/APPEND_ONLY/);
    // a NEW assignment after revocation is a new row; history is kept
    const again = await ops.assign({ userId: u.id, role: 'fraud_investigator' }, f.ctx(owner.id)); expect(again.id).not.toBe(a.id);
    const hist = await ops.history(a.id); expect(hist.map((h) => h.eventType)).toEqual(['assigned', 'revoked']);
    await expect(f.q(`UPDATE governance_operator_events SET event_type = 'assigned' WHERE operator_id = $1`, [a.id])).rejects.toThrow(/APPEND_ONLY/);
    await expect(f.q(`TRUNCATE governance_operator_events`)).rejects.toThrow();
    await expect(f.q(`INSERT INTO governance_operators (user_id, role) VALUES ($1,'dispute_resolver')`, [u.id])).rejects.toThrow(/NOT_ALLOWED/); // no assigner
  });

  it('EXPIRY and SCOPE are enforced by the database at the moment of use: an expired, revoked or out-of-scope operator cannot review', async () => {
    const shortLived = await f.user('g5-expiring', false); const wrongScope = await f.user('g5-drops-only', false); const good = await f.user('g5-good', false);
    await ops.assign({ userId: good.id, role: 'fraud_investigator', scope: 'both' }, f.ctx(owner.id));
    await ops.assign({ userId: wrongScope.id, role: 'fraud_investigator', scope: 'drops' }, f.ctx(owner.id));
    await ops.assign({ userId: shortLived.id, role: 'fraud_investigator', expiresAt: new Date(Date.now() + 1500) }, f.ctx(owner.id));
    const c1 = await shuffleCase(); const c2 = await shuffleCase(); const c3 = await shuffleCase();
    await expect(gov.startReview(c1.id, f.ctx(wrongScope.id))).rejects.toMatchObject({ code: 'OPERATOR_NOT_ASSIGNED' }); // scope does not cover shuffle
    expect((await gov.startReview(c2.id, f.ctx(shortLived.id))).status).toBe('under_review'); // inside the window
    await new Promise((r) => setTimeout(r, 1800));
    expect(await ops.isEffective(shortLived.id, 'fraud_investigator', 'shuffle')).toBe(false);
    await expect(gov.startReview(c3.id, f.ctx(shortLived.id))).rejects.toMatchObject({ code: 'OPERATOR_NOT_ASSIGNED' }); // expired
    expect((await gov.startReview(c3.id, f.ctx(good.id))).status).toBe('under_review');
    expect(await ops.isEffective(good.id, 'fraud_investigator', 'shuffle', new Date(Date.now() - 86_400_000))).toBe(false); // not yet valid in the past
  });

  it('DECISION POLICIES: draft -> approved by a DIFFERENT person -> retired; versions are immutable; one approved policy per kind and family; structural parameters only', async () => {
    const pol = new GovernanceDecisionPolicyService(f.db);
    await expect(pol.createDraft({ policyKey: `g5_bad_${tag}`.slice(0, 60), kind: 'fraud', subjectFamily: 'shuffle', parameters: { allowedDecisions: ['upheld'], minEvidenceItems: 0, fraudScoreThreshold: 0.9 } }, f.ctx(owner.id))).rejects.toMatchObject({ code: 'POLICY_PARAMETERS_INVALID' }); // no invented thresholds
    await expect(pol.createDraft({ policyKey: `g5_bad_${tag}`.slice(0, 60), kind: 'override', subjectFamily: 'drops', parameters: { allowedScopes: ['void_allocated_unit'] } }, f.ctx(owner.id))).rejects.toMatchObject({ code: 'POLICY_PARAMETERS_INVALID' }); // no new override scope
    const key = `g5_pol_${tag}`.slice(0, 60);
    const d1 = await pol.createDraft({ policyKey: key, kind: 'dispute', subjectFamily: 'drops', parameters: { allowedDecisions: ['upheld'], minEvidenceItems: 1 } }, f.ctx(owner.id));
    const d2 = await pol.createDraft({ policyKey: key, kind: 'dispute', subjectFamily: 'drops', parameters: { allowedDecisions: ['upheld', 'no_action'], minEvidenceItems: 1 } }, f.ctx(owner.id));
    expect([d1.version, d2.version]).toEqual([1, 2]);
    await expect(pol.approve(d1.id, f.ctx(owner.id))).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' });
    await expect(pol.approve(d1.id, f.ctx(owner2.id))).rejects.toMatchObject({ code: 'POLICY_ALREADY_APPROVED' }); // the synthetic dispute/drops policy is already approved
    await expect(f.q(`UPDATE governance_decision_policies SET parameters = '{"allowedDecisions":["upheld"],"minEvidenceItems":0}' WHERE id = $1`, [d1.id])).rejects.toThrow(/IMMUTABLE/);
    await expect(f.q(`DELETE FROM governance_decision_policies WHERE id = $1`, [d1.id])).rejects.toThrow(/IMMUTABLE/);
    await expect(f.q(`INSERT INTO governance_decision_policies (policy_key, version, kind, subject_family, parameters, parameters_hash, approval_state, created_by_user_id, approved_by_user_id, approved_at) VALUES ('x_${tag}',1,'fraud','shuffle','{"allowedDecisions":["upheld"],"minEvidenceItems":0}', repeat('a',64), 'approved', $1, $2, now())`, [owner.id, owner2.id])).rejects.toThrow(/IMMUTABLE/); // starts as a draft
    await expect(f.q(`TRUNCATE governance_decision_policies`)).rejects.toThrow();
  });

  it('A DECISION IS BLOCKED without an approved policy and bound to the policy rules (isolated in a rolled-back transaction)', async () => {
    const c = await shuffleCase(); const investigator = await f.user('g5-inv-pol', false); const resolver = await f.user('g5-res-pol', false);
    await ops.assign({ userId: investigator.id, role: 'fraud_investigator' }, f.ctx(owner.id));
    await gov.startReview(c.id, f.ctx(investigator.id));
    // in the normal state the synthetic approved policy lets the reviewer decide and records the policy version used
    await rolledBack(async (txDb) => {
      const txGov = new GovernanceService(txDb, ON); const txPol = new GovernanceDecisionPolicyService(txDb);
      await txDb.execute(sql`UPDATE governance_decision_policies SET approval_state='retired', retired_at=now() WHERE kind='fraud' AND subject_family='shuffle' AND approval_state='approved'`);
      await expect(txGov.decide(c.id, 'upheld', 'Synthetic decision without a policy.', f.ctx(investigator.id))).rejects.toMatchObject({ code: 'POLICY_NOT_APPROVED' });
      // a stricter approved policy: one decision allowed and one evidence item required
      const d = await txPol.createDraft({ policyKey: `g5_strict_${tag}`.slice(0, 60), kind: 'fraud', subjectFamily: 'shuffle', parameters: { allowedDecisions: ['no_action'], minEvidenceItems: 1 } }, f.ctx(owner.id));
      await txPol.approve(d.id, f.ctx(owner2.id));
      await expect(txGov.decide(c.id, 'upheld', 'Synthetic decision outside the policy.', f.ctx(investigator.id))).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
      await expect(txGov.decide(c.id, 'no_action', 'Synthetic decision lacking evidence.', f.ctx(investigator.id))).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    });
    void resolver;
    const decided = await gov.decide(c.id, 'upheld', 'Synthetic decision under the approved policy.', f.ctx(investigator.id));
    expect(decided.status).toBe('decided'); expect(decided.decisionPolicyId).toBeTruthy();
    await expect(f.q(`UPDATE governance_cases SET decision_policy_id = NULL WHERE id = $1`, [c.id])).rejects.toThrow(/IMMUTABLE|TRANSITION/);
  });

  it('OVERRIDES need an approved override policy that allows the scope (database-enforced)', async () => {
    const s = await f.shuffleScenario({ creatorId: creator.id, businessId: biz, ruleId: rule, entries: 1 });
    const c = await gov.openCase({ kind: 'fraud', subjectType: 'shuffle_entry', subjectId: s.entryIds[0]!, classification: 'suspected_duplicate_participation', summary: 'Synthetic governance case.' }, f.ctx(opener.id));
    const inv = await f.user('g5-inv-ov', false); await ops.assign({ userId: inv.id, role: 'fraud_investigator' }, f.ctx(owner.id)); await gov.startReview(c.id, f.ctx(inv.id));
    await rolledBack(async (txDb) => {
      await txDb.execute(sql`UPDATE governance_decision_policies SET approval_state='retired', retired_at=now() WHERE kind='override' AND subject_family='shuffle' AND approval_state='approved'`);
      const txGov = new GovernanceService(txDb, ON);
      await expect(txGov.requestOverride(c.id, { scope: 'cancel_entry_before_selection', targetId: s.entryIds[0]!, justification: 'Synthetic justification for the test.', expiresAt: new Date(Date.now() + 3_600_000) }, f.ctx(inv.id))).rejects.toMatchObject({ code: 'POLICY_NOT_APPROVED' });
    });
    const o = await gov.requestOverride(c.id, { scope: 'cancel_entry_before_selection', targetId: s.entryIds[0]!, justification: 'Synthetic justification for the test.', expiresAt: new Date(Date.now() + 3_600_000) }, f.ctx(inv.id));
    expect(o.status).toBe('requested');
  });
});
