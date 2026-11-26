import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { BusinessClosureService } from '../../src/business-closure/business-closure.service';
import { GovernanceService } from '../../src/governance/governance.service';
import { makeFixtures } from './helpers/tentaship-fixtures';

/** G9 against real PostgreSQL: the closure assessment sees Tentaship obligations (read-only counts; nothing is closed, changed or resolved). Synthetic data only. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');

describe.skipIf(!databaseUrl)('G9 business closure assessment includes Tentaship obligations (real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>; let admin: { id: string }; let reviewer: { id: string }; let rule: string;
  beforeAll(async () => { client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client); admin = await f.user('g9-admin'); reviewer = await f.user('g9-reviewer'); rule = await f.rule(admin.id); });
  afterAll(async () => { await client?.end(); });

  it('counts active sponsorships, allocated-but-uncollected units and open governance cases for THIS business only; closure stays blocked', async () => {
    const biz = await f.business('g9a'); const other = await f.business('g9b');
    const svc = new BusinessClosureService(f.db);
    const before = await svc.obligations(biz); expect(before).toMatchObject({ activeSponsorships: 0, unitsAwaitingCollection: 0, openGovernanceCases: 0 });
    const d = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: biz, ruleId: rule, quantity: 3, reserve: 2, allocate: 1 });
    await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: other, ruleId: rule, quantity: 1, reserve: 1, allocate: 1 });
    const o = await svc.obligations(biz);
    expect(o.activeSponsorships).toBe(1); expect(o.unitsAwaitingCollection).toBe(2); // one reserved + one allocated, both unresolved
    const gov = new GovernanceService(f.db, { shuffle: true, drops: true });
    await gov.openCase({ kind: 'dispute', subjectType: 'drop_sponsorship', subjectId: d.sponsorshipId, classification: 'allocation_dispute', summary: 'Synthetic closure-assessment case.' }, f.ctx(admin.id));
    const o2 = await svc.obligations(biz); expect(o2.openGovernanceCases).toBe(1);
    const e = await svc.eligibility(biz);
    expect(e.processing).toBe('blocked'); expect(e.blockers).toEqual(expect.arrayContaining(['CLOSURE_POLICY_NOT_APPROVED', 'ACTIVE_SPONSORSHIPS', 'UNITS_AWAITING_COLLECTION', 'OPEN_GOVERNANCE_CASES']));
    expect((await svc.obligations(other)).openGovernanceCases).toBe(0); // tenant-scoped
    // read-only: nothing about the sponsorship or its units changed
    expect(Number((await f.q(`SELECT count(*)::int n FROM drop_reservations WHERE sponsorship_id=$1`, [d.sponsorshipId]))[0].n)).toBe(2);
  });
});
