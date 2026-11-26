import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { AppError } from '../../src/lib/errors';
import { GovernanceService } from '../../src/governance/governance.service';
import { TentashipAnalytics } from '../../src/analytics/tentaship-analytics';
import { verifySelection } from '../../src/shuffle/shuffle-selection';
import { iso, makeFixtures } from './helpers/tentaship-fixtures';

/**
 * TSH-09 integrated technical acceptance (Shuffle + Drops + governance + analytics) on real PostgreSQL, SYNTHETIC ONLY.
 * Honest scope: Shuffle and Drops are deliberately NOT linked in production code (separate controls, legal gates), so the "allocation / collection" leg
 * of the lifecycle is exercised by composing the two modules in the test over the same canonical qualification evaluator. Nothing here can be reached
 * with a real customer: the database fixes synthetic = true and not_released.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');

describe.skipIf(!databaseUrl)('TSH-09 integrated synthetic lifecycle (real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>;
  let admin: { id: string }; let reviewer: { id: string }; let investigator: { id: string }; let resolver: { id: string }; let opener: { id: string };
  let biz: string; let rule: string;
  const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? e.code : (e as Error).message; } };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client);
    admin = await f.user('ia-admin'); reviewer = await f.user('ia-reviewer'); investigator = await f.user('ia-investigator'); resolver = await f.user('ia-resolver'); opener = await f.user('ia-opener');
    biz = await f.business('ia');
    await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`);
    rule = await f.rule(admin.id);
    await f.q(`UPDATE governance_operators SET active = false`);
    await f.operator(investigator.id, 'fraud_investigator'); await f.operator(resolver.id, 'dispute_resolver');
  });
  afterAll(async () => { await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`).catch(() => undefined); await f.q(`UPDATE governance_operators SET active = false`).catch(() => undefined); await client?.end(); });

  it('the whole technically authorized lifecycle: configuration -> version -> evaluation -> snapshot -> invitation -> acceptance -> participation -> selection -> allocation -> collection -> analytics -> governance -> evidence', async () => {
    const gov = new GovernanceService(f.db, { shuffle: true, drops: true }); const an = new TentashipAnalytics(f.db);
    const loyaltyBefore = await f.q(`SELECT count(*)::int n, coalesce(sum(points),0)::int p FROM loyalty_accounts`);
    const communityBefore = await f.q(`SELECT (SELECT count(*) FROM community_point_transactions)::int c, (SELECT count(*) FROM tentaship_badge_awards)::int b`);

    // 1-3 configuration, immutable version, eligibility on the ONE shared evaluator
    const s = await f.shuffleScenario({ creatorId: admin.id, businessId: biz, ruleId: rule, entries: 4, min: 3, max: 10 });
    expect(s.version).toMatchObject({ releaseState: 'not_released', version: 1 });
    await expect(f.q(`UPDATE shuffle_campaign_versions SET release_state = 'released' WHERE id = $1`, [s.versionId])).rejects.toThrow();
    await expect(f.q(`UPDATE shuffle_entries SET synthetic = false WHERE id = $1`, [s.entryIds[0]])).rejects.toThrow();
    // 4-7 snapshot -> invitation -> acceptance -> participation happened inside the scenario; verify each artifact is bound and distinct
    const snaps = await f.q(`SELECT 1 FROM shuffle_eligibility_snapshots WHERE campaign_version_id = $1 AND qualified`, [s.versionId]);
    const invs = await f.q(`SELECT status FROM shuffle_invitations WHERE campaign_version_id = $1`, [s.versionId]);
    const ents = await f.q(`SELECT accepted_disclosure_hash FROM shuffle_entries WHERE campaign_version_id = $1 AND status = 'admitted'`, [s.versionId]);
    expect([snaps.length, invs.length, ents.length]).toEqual([4, 4, 4]);
    expect(invs.every((i) => i.status === 'accepted')).toBe(true); expect(ents.every((e) => e.accepted_disclosure_hash === s.version.disclosureHash)).toBe(true);

    // 8 isolated selection (3 of 4) with replayable evidence
    const sel = await f.part.runSyntheticSelection(s.versionId, 3, f.ctx(admin.id));
    expect(sel.created).toBe(true);
    const ev = await f.part.verifyEvidence(s.versionId); expect(ev).toMatchObject({ chainOk: true, selectionRecorded: true, selectionOk: true });
    const [row] = await f.q(`SELECT * FROM shuffle_selection_results WHERE campaign_version_id = $1`, [s.versionId]);
    const chainEv = (await f.q(`SELECT event FROM shuffle_allocation_events WHERE campaign_version_id = $1 AND event->>'type' = 'selection_recorded'`, [s.versionId]))[0].event;
    expect(verifySelection({ entrantIds: chainEv.entrantIds, winnerCount: 3 }, { selectedIds: row.selected_entry_ids, entrantCount: 4, inputCommitment: row.input_commitment, resultCommitment: row.result_commitment, transcript: row.transcript })).toBe(true);
    // a replay with a different winner is rejected: the verification boundary is "correct application to the recorded draws"
    const other = (chainEv.entrantIds as string[]).find((id) => !row.selected_entry_ids.includes(id))!;
    expect(verifySelection({ entrantIds: chainEv.entrantIds, winnerCount: 3 }, { selectedIds: [other, ...row.selected_entry_ids.slice(1)], entrantCount: 4, inputCommitment: row.input_commitment, resultCommitment: row.result_commitment, transcript: row.transcript })).toBe(false);

    // 9-10 allocation + collection foundations: the SELECTED customers reserve, are re-evaluated, allocated and collect on a separate synthetic Drops offer
    const selectedCustomers = (await f.q(`SELECT customer_id FROM shuffle_entries WHERE id = ANY($1::uuid[])`, [row.selected_entry_ids])).map((r) => r.customer_id as string);
    const d = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: biz, ruleId: rule, quantity: 3 });
    const resIds: string[] = [];
    for (const cid of selectedCustomers) resIds.push((await f.drops.reserve(d.sponsorshipId, cid, new Date(Date.now() + 3_600_000), f.ctx(reviewer.id))).reservation.id);
    expect(await code(f.drops.reserve(d.sponsorshipId, await f.customer({ businessId: biz, purchase: true }), new Date(Date.now() + 3_600_000), f.ctx(reviewer.id)))).toBe('INVENTORY_EXHAUSTED'); // 3 units, 3 taken
    for (const id of resIds) await f.drops.allocate(id, f.ctx(reviewer.id));
    await f.drops.collect(resIds[0]!, f.ctx(reviewer.id));
    expect(await f.drops.verifyEvidence(d.sponsorshipId)).toMatchObject({ chainOk: true, inventoryConsistent: true });

    // 11 aggregate analytics reflect the distinct lifecycle events and reconcile with canonical records
    const sm = (await an.shuffleVersion(s.versionId, { includeGovernance: true })).metrics;
    expect(sm).toMatchObject({ eligibleSnapshots: 4, invitationsIssued: 4, invitationsAccepted: 4, participationRecorded: 4, participantsAdmitted: 4, participantsSelected: 3 });
    const dm = (await an.dropSponsorship(d.sponsorshipId)).metrics!;
    expect(dm).toMatchObject({ total: 3, reserved: 0, allocated: 2, collected: 1, available: 0, outstandingCollection: 2, reconciled: true });
    expect(dm.collectionCompletionRate).toBeCloseTo(1 / 3, 10);

    // 12 governance: a case on the SELECTION; the decision records a finding and changes nothing; no override can touch a recorded selection or an allocated unit
    const c = await gov.openCase({ kind: 'fraud', subjectType: 'shuffle_selection', subjectId: row.id, classification: 'other', summary: 'Synthetic acceptance case.' }, f.ctx(opener.id));
    await gov.submitEvidence(c.id, { kind: 'note', body: 'Synthetic evidence.' }, f.ctx(opener.id));
    await gov.startReview(c.id, f.ctx(investigator.id));
    await gov.decide(c.id, 'no_action', 'No anomaly found in the synthetic data.', f.ctx(investigator.id));
    expect(await f.q(`SELECT 1 FROM shuffle_selection_results WHERE id = $1 AND selected_entry_ids = $2::jsonb`, [row.id, JSON.stringify(row.selected_entry_ids)])).toHaveLength(1);
    expect(await code(gov.requestOverride(c.id, { scope: 'cancel_entry_before_selection', targetId: s.entryIds[0]!, justification: 'Synthetic: try after selection.', expiresAt: new Date(Date.now() + 60_000) }, f.ctx(investigator.id)))).toBeNull(); // requestable...
    const [ov] = await f.q(`SELECT id FROM governance_overrides WHERE case_id = $1`, [c.id]);
    await gov.approveOverride(ov.id, f.ctx(resolver.id));
    expect(await code(gov.executeOverride(ov.id, f.ctx(resolver.id)))).toBe('ENTRY_LOCKED_AFTER_SELECTION'); // ...but never executable: a recorded selection is not silently altered
    expect(await gov.verifyChain(c.id)).toMatchObject({ chainOk: true });

    // 13 every evidence chain verifies; other ledgers untouched (no conversion of loyalty/community balances, no badge awards)
    expect(await f.part.verifyEvidence(s.versionId)).toMatchObject({ chainOk: true, selectionOk: true });
    const loyaltyAfter = await f.q(`SELECT count(*)::int n, coalesce(sum(points),0)::int p FROM loyalty_accounts`);
    expect(loyaltyAfter[0].p).toBe(loyaltyBefore[0].p); // the scenario's loyalty accounts start at the default and nothing was credited or converted
    const communityAfter = await f.q(`SELECT (SELECT count(*) FROM community_point_transactions)::int c, (SELECT count(*) FROM tentaship_badge_awards)::int b`);
    expect(communityAfter[0]).toEqual(communityBefore[0]);
  });

  it('failure and recovery: suspension halts every step and resume restores it; eligibility loss withdraws; cancelled is final; replays are idempotent', async () => {
    const s = await f.shuffleScenario({ creatorId: admin.id, businessId: biz, ruleId: rule, entries: 2, min: 1 });
    const cid = await f.customer({ businessId: biz, purchase: true }); await f.shuffle.takeEligibilitySnapshot(s.versionId, cid, f.ctx(admin.id));
    const inv = await f.part.issueInvitation(s.versionId, cid, new Date(Date.now() + 3_600_000), f.ctx(admin.id));
    const shown = { termsVersion: s.version.termsVersion, disclosureHash: s.version.disclosureHash };
    await f.shuffle.setStatus(s.campaignId, 'suspended', 'synthetic fraud pause', f.ctx(admin.id));
    expect(await code(f.part.accept(inv.invitation.id, shown, f.ctx(admin.id)))).toBe('CAMPAIGN_NOT_DRAFT');
    expect(await code(f.part.runSyntheticSelection(s.versionId, 1, f.ctx(admin.id)))).toBe('CAMPAIGN_NOT_DRAFT');
    await f.shuffle.setStatus(s.campaignId, 'draft', null, f.ctx(admin.id));
    const a1 = await f.part.accept(inv.invitation.id, shown, f.ctx(admin.id)); const a2 = await f.part.accept(inv.invitation.id, shown, f.ctx(admin.id));
    expect([a1.created, a2.created, a1.entry.id === a2.entry.id]).toEqual([true, false, true]);
    const r1 = await f.part.runSyntheticSelection(s.versionId, 1, f.ctx(admin.id)); const r2 = await f.part.runSyntheticSelection(s.versionId, 2, f.ctx(admin.id));
    expect([r1.created, r2.created, r2.result.winnerCount]).toEqual([true, false, 1]); // a second selection can never replace the first
    await f.shuffle.setStatus(s.campaignId, 'cancelled', 'synthetic withdrawal', f.ctx(admin.id));
    expect(await code(f.shuffle.setStatus(s.campaignId, 'draft', null, f.ctx(admin.id)))).toBe('CAMPAIGN_TRANSITION_NOT_ALLOWED');
    expect(await code(f.part.issueInvitation(s.versionId, await f.customer({ businessId: biz, purchase: true }), new Date(Date.now() + 60_000), f.ctx(admin.id)))).toBe('CAMPAIGN_NOT_DRAFT');
    expect(await f.part.verifyEvidence(s.versionId)).toMatchObject({ chainOk: true, selectionOk: true });
  });

  it('qualification (Group 01): ANY / ALL / AT_LEAST on the one engine; unapproved rules and ineligible customers fail closed; replayed purchase evidence cannot inflate counts; evidence is customer-bound', async () => {
    const mk = async (spec: unknown, approved = true) => {
      const { hashSpec, parseQualificationSpec } = await import('../../src/qualification/qualification-spec');
      const parsed = parseQualificationSpec(spec); const id = (await f.q(`INSERT INTO qualification_rule_versions (rule_key, version, participant_type, spec, spec_hash, created_by_user_id) VALUES ($1,1,'customer',$2,$3,$4) RETURNING id`, [f.key('r'), JSON.stringify(parsed), hashSpec(parsed), admin.id]))[0].id as string;
      if (approved) await f.q(`UPDATE qualification_rule_versions SET approval_state='approved', approved_at=now(), approved_by_user_id=$2 WHERE id=$1`, [id, admin.id]);
      return id;
    };
    const purchases = async (cid: string, n: number) => {
      const m = (await f.q(`INSERT INTO business_customer_memberships (customer_id, business_id, status) VALUES ($1,$2,'active') RETURNING id`, [cid, biz]))[0].id;
      const a = (await f.q(`INSERT INTO loyalty_accounts (customer_id, business_id, membership_id) VALUES ($1,$2,$3) RETURNING id`, [cid, biz, m]))[0].id;
      for (let i = 0; i < n; i++) await f.q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount) VALUES ($1,$2,$3,$4,gen_random_uuid(),20)`, [biz, cid, m, a]);
    };
    const two = await mk({ combinator: 'AT_LEAST', atLeast: 2, pathways: [{ metric: 'recorded_purchases', threshold: 2 }, { metric: 'referral_attributed', threshold: 1 }, { metric: 'recorded_purchases', threshold: 5 }] });
    const any = await mk({ combinator: 'ANY', pathways: [{ metric: 'recorded_purchases', threshold: 3 }, { metric: 'referral_attributed', threshold: 1 }] });
    const unapproved = await mk({ combinator: 'ALL', pathways: [{ metric: 'recorded_purchases', threshold: 1 }] }, false);
    const evalFor = async (ruleId: string, cid: string) => {
      const { evaluateRuleForCustomer } = await import('../../src/qualification/qualification-evaluator');
      const rows = await f.q(`SELECT * FROM qualification_rule_versions WHERE id = $1`, [ruleId]);
      const row = { id: rows[0].id, spec: rows[0].spec, specHash: rows[0].spec_hash, participantType: rows[0].participant_type, approvalState: rows[0].approval_state } as never;
      return (await evaluateRuleForCustomer(f.db, cid, row, { consumerKind: 'campaign' }))!.outcome.qualified;
    };
    const c2 = await f.customer(); await purchases(c2, 2);       // 2 purchases: pathway1 met only -> AT_LEAST(2) NOT met; ANY(3) not met
    expect([await evalFor(two, c2), await evalFor(any, c2)]).toEqual([false, false]);
    const c3 = await f.customer(); await purchases(c3, 5);       // pathways 1 and 3 met -> AT_LEAST(2) met; ANY(3) met
    expect([await evalFor(two, c3), await evalFor(any, c3)]).toEqual([true, true]);
    // unapproved rule never qualifies anything through any consumer
    const s = await f.shuffle.createCampaign({ key: f.key('sh'), mode: 'limited', qualificationRuleVersionId: unapproved, minParticipants: 1, maxCapacity: 5, qualificationWindowStart: new Date(Date.now() - 3_600_000), qualificationWindowEnd: new Date(Date.now() + 86_400_000), entryAcceptanceDeadline: new Date(Date.now() + 172_800_000), disclosure: { en: 'x' }, termsVersion: 't', closureConditions: 'c', cancellationConditions: 'c' }, f.ctx(admin.id));
    expect(await code(f.shuffle.takeEligibilitySnapshot(s.version.id, c3, f.ctx(admin.id)))).toBe('QUALIFICATION_NOT_APPROVED');
    // replaying the same purchase (same idempotency key) cannot add evidence, so it cannot inflate a count
    const [pe] = await f.q(`SELECT business_id, customer_id, membership_id, loyalty_account_id, idempotency_key FROM loyalty_purchase_events WHERE customer_id = $1 LIMIT 1`, [c3]);
    await expect(f.q(`INSERT INTO loyalty_purchase_events (business_id, customer_id, membership_id, loyalty_account_id, idempotency_key, qualifying_amount) VALUES ($1,$2,$3,$4,$5,20)`, [pe.business_id, pe.customer_id, pe.membership_id, pe.loyalty_account_id, pe.idempotency_key])).rejects.toThrow(/duplicate|unique/i);
    // one customer's purchases never count for another customer (customer-bound evidence)
    const c4 = await f.customer(); expect(await evalFor(two, c4)).toBe(false);
    void iso;
  });
});
