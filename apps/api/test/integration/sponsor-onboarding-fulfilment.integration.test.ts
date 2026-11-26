import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { FulfilmentPolicyService } from '../../src/sponsors/fulfilment-policy.service';
import { SponsorApplicationService } from '../../src/sponsors/sponsor-application.service';
import { makeFixtures, tag } from './helpers/tentaship-fixtures';

/** G6 against real PostgreSQL: sponsor application lifecycle with independent review, DB-enforced sponsor gating of Drops, and versioned fulfilment policy interfaces. Synthetic only. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');

describe.skipIf(!databaseUrl)('G6 sponsor onboarding and fulfilment policy (real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>; let sub: { id: string }; let rev: { id: string }; let rev2: { id: string }; let plain: { id: string }; let svc: SponsorApplicationService;
  let creator: { id: string }; let rule: string;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client);
    sub = await f.user('g6-submitter', false); rev = await f.user('g6-reviewer'); rev2 = await f.user('g6-reviewer2'); plain = await f.user('g6-nonadmin', false); creator = await f.user('g6-creator');
    rule = await f.rule(creator.id); svc = new SponsorApplicationService(f.db);
  });
  afterAll(async () => { await client?.end(); });

  it('LIFECYCLE: independent review, reasons, final revocation, one live application, audited', async () => {
    const biz = await f.business('g6a');
    const a = await svc.submit(biz, 'We would like to sponsor a synthetic item.', f.ctx(sub.id));
    expect(a.status).toBe('submitted'); expect(a.eligibilityAssessment).toEqual({ businessActive: true, noPendingClosureRequest: true });
    await expect(svc.submit(biz, 'Again.', f.ctx(sub.id))).rejects.toMatchObject({ code: 'APPLICATION_EXISTS' });
    await expect(svc.startReview(a.id, f.ctx(sub.id))).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' }); // submitter cannot review (even if admin they are not)
    await expect(svc.startReview(a.id, f.ctx(plain.id))).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' }); // not a platform administrator
    await svc.startReview(a.id, f.ctx(rev.id));
    await expect(svc.approve(a.id, f.ctx(rev2.id))).rejects.toThrow(); // only the assigned reviewer decides
    await svc.approve(a.id, f.ctx(rev.id));
    expect(await svc.isApproved(biz)).toBe(true);
    await expect(svc.suspend(a.id, 'short', f.ctx(rev.id))).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await svc.suspend(a.id, 'Synthetic suspension for the test.', f.ctx(rev.id)); expect(await svc.isApproved(biz)).toBe(false);
    await svc.reinstate(a.id, 'Synthetic reinstatement for the test.', f.ctx(rev.id)); expect(await svc.isApproved(biz)).toBe(true);
    await svc.revoke(a.id, 'Synthetic revocation for the test.', f.ctx(rev.id)); expect(await svc.isApproved(biz)).toBe(false);
    await expect(svc.reinstate(a.id, 'Cannot come back after revocation.', f.ctx(rev.id))).rejects.toMatchObject({ code: 'TRANSITION_NOT_ALLOWED' });
    await expect(f.q(`UPDATE sponsor_applications SET status = 'approved', decided_by_user_id = $2 WHERE id = $1`, [a.id, rev.id])).rejects.toThrow(/TRANSITION_NOT_ALLOWED/);
    expect((await svc.history(a.id)).map((e) => e.eventType)).toEqual(['submitted', 'under_review', 'approved', 'suspended', 'approved', 'revoked']);
    await expect(f.q(`DELETE FROM sponsor_applications WHERE id = $1`, [a.id])).rejects.toThrow(/IMMUTABLE/);
    await expect(f.q(`UPDATE sponsor_application_events SET event_type = 'x' WHERE application_id = $1`, [a.id])).rejects.toThrow(/APPEND_ONLY/);
    await expect(f.q(`TRUNCATE sponsor_applications`)).rejects.toThrow();
    await expect(f.q(`UPDATE sponsor_applications SET synthetic = false WHERE id = $1`, [a.id])).rejects.toThrow();
    // a rejected application needs a reason and leaves the business free to apply again
    const b = await svc.submit(biz, 'A second synthetic application.', f.ctx(sub.id)); await svc.startReview(b.id, f.ctx(rev.id));
    await expect(svc.reject(b.id, 'no', f.ctx(rev.id))).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    expect((await svc.reject(b.id, 'Synthetic rejection for the test.', f.ctx(rev.id))).status).toBe('rejected');
    const w = await svc.submit(biz, 'A third synthetic application.', f.ctx(sub.id)); expect((await svc.withdraw(w.id, f.ctx(sub.id))).status).toBe('withdrawn');
  });

  it('ELIGIBILITY: an inactive business or one with a pending closure request cannot apply', async () => {
    const closing = await f.business('g6c'); await f.q(`INSERT INTO business_closure_requests (business_id, requested_by_user_id, obligations_snapshot) VALUES ($1,$2,'{}')`, [closing, sub.id]);
    await expect(svc.submit(closing, 'We are closing.', f.ctx(sub.id))).rejects.toMatchObject({ code: 'SPONSOR_NOT_ELIGIBLE' });
    const suspended = await f.business('g6s'); await f.q(`UPDATE businesses SET status='suspended' WHERE id=$1`, [suspended]);
    await expect(svc.submit(suspended, 'Suspended business.', f.ctx(sub.id))).rejects.toMatchObject({ code: 'SPONSOR_NOT_ELIGIBLE' });
  });

  it('DROPS ARE GATED BY THE SPONSOR (database-enforced): no opening without approval; suspension stops NEW reservations but allocated units stay honoured', async () => {
    const biz = await f.business('g6d');
    // no approved sponsor: the sponsorship can be drafted and approved but never scheduled/opened
    const draft = await f.drops.create({ key: f.key('dpg'), businessId: biz, productName: 'Synthetic item', description: 'A synthetic, non-commercial test unit.', quantityTotal: 2, collectionMethod: 'In person', collectionLocation: 'Synthetic counter',
      collectionWindowStart: new Date(Date.now() - 3_600_000), collectionWindowEnd: new Date(Date.now() + 86_400_000), offerExpiresAt: new Date(Date.now() + 86_400_000), qualificationRuleVersionId: rule }, f.ctx(creator.id));
    const id = draft.sponsorship.id;
    await f.drops.move(id, 'submitted', f.ctx(creator.id)); await f.drops.move(id, 'under_review', f.ctx(creator.id)); await f.drops.move(id, 'approved', f.ctx(rev.id));
    await expect(f.drops.move(id, 'scheduled', f.ctx(rev.id))).rejects.toMatchObject({ code: 'SPONSOR_NOT_APPROVED' });
    await f.sponsor(biz);
    await f.drops.move(id, 'scheduled', f.ctx(rev.id)); await f.drops.move(id, 'available', f.ctx(rev.id));
    const c1 = await f.customer({ businessId: biz, purchase: true }); const c2 = await f.customer({ businessId: biz, purchase: true });
    const r1 = await f.drops.reserve(id, c1, new Date(Date.now() + 3_600_000), f.ctx(rev.id)); await f.drops.allocate(r1.reservation.id, f.ctx(rev.id));
    const app = (await f.q(`SELECT id FROM sponsor_applications WHERE business_id = $1 AND status = 'approved'`, [biz]))[0].id as string;
    await svc.suspend(app, 'Synthetic suspension for the test.', f.ctx(rev.id));
    await expect(f.drops.reserve(id, c2, new Date(Date.now() + 3_600_000), f.ctx(rev.id))).rejects.toMatchObject({ code: 'SPONSOR_NOT_APPROVED' });
    expect((await f.q(`SELECT status FROM drop_reservations WHERE id = $1`, [r1.reservation.id]))[0].status).toBe('allocated'); // honoured
    await expect(f.q(`INSERT INTO drop_reservations (sponsorship_id, customer_id, hold_expires_at, eligibility_evidence, created_by_user_id) VALUES ($1,$2, now() + interval '1 hour', '{}', $3)`, [id, c2, rev.id])).rejects.toThrow(/NOT_ALLOWED/); // the database refuses too
    const col = await f.drops.collect(r1.reservation.id, f.ctx(rev.id)); expect(col.status).toBe('collected'); // an allocated unit can still be collected
  });

  it('FULFILMENT POLICY: versioned, immutable, approved by a different person; interfaces are unavailable without an approved policy and invent no SLA', async () => {
    const pol = new FulfilmentPolicyService(f.db);
    await f.q(`UPDATE drop_fulfilment_policies SET approval_state='retired', retired_at=now() WHERE approval_state='approved'`);
    expect(await pol.collectionPolicy()).toEqual({ available: false, reason: 'NO_APPROVED_FULFILMENT_POLICY' });
    const any = (await f.q(`SELECT id FROM drop_sponsorships LIMIT 1`))[0].id as string;
    expect(await pol.escalations(any)).toEqual({ available: false, reason: 'NO_APPROVED_FULFILMENT_POLICY' });
    await expect(pol.createDraft({ policyKey: `g6_bad_${tag}`.slice(0, 60), parameters: { collectionVerification: 'staff_confirmation', slaMinutes: 30 } }, f.ctx(creator.id))).rejects.toMatchObject({ code: 'POLICY_PARAMETERS_INVALID' });
    const d = await pol.createDraft({ policyKey: `g6_pol_${tag}`.slice(0, 60), parameters: { collectionVerification: 'collection_code' } }, f.ctx(creator.id));
    await expect(pol.approve(d.id, f.ctx(creator.id))).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' });
    await pol.approve(d.id, f.ctx(rev.id));
    expect(await pol.collectionPolicy()).toMatchObject({ available: true, verification: 'collection_code' });
    expect(await pol.escalations(any)).toEqual({ available: false, reason: 'POLICY_SETS_NO_ESCALATION_AGE' }); // no invented age
    await expect(f.q(`UPDATE drop_fulfilment_policies SET parameters = '{"collectionVerification":"staff_confirmation"}' WHERE id = $1`, [d.id])).rejects.toThrow(/IMMUTABLE/);
    const d2 = await pol.createDraft({ policyKey: `g6_pol_${tag}`.slice(0, 60), parameters: { collectionVerification: 'staff_confirmation', escalateAfterHours: 48 } }, f.ctx(creator.id));
    expect(d2.version).toBe(2);
    await expect(pol.approve(d2.id, f.ctx(rev.id))).rejects.toMatchObject({ code: 'POLICY_ALREADY_APPROVED' });
    await pol.retire(d.id); await pol.approve(d2.id, f.ctx(rev.id));
    const e = await pol.escalations(any); expect(e).toMatchObject({ available: true, overdueUnits: 0 }); expect(JSON.stringify(e)).not.toMatch(/customer/i);
    await f.q(`UPDATE drop_fulfilment_policies SET approval_state='retired', retired_at=now() WHERE approval_state='approved'`);
  });
});
