import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from 'pg';
import type { Bindings } from '../../src/config/env';
import { errorHandler } from '../../src/lib/error-handler';
import { auditTrail } from '../../src/middleware/audit';
import { cashierScopeGuard } from '../../src/middleware/cashier-scope';
import { platformShuffleRoutes } from '../../src/platform/shuffle.routes';
import { platformDropsRoutes } from '../../src/platform/drops.routes';
import { DROP_METRIC_DEFINITIONS, SHUFFLE_METRIC_DEFINITIONS, TentashipAnalytics } from '../../src/analytics/tentaship-analytics';
import { makeFixtures, SECRET } from './helpers/tentaship-fixtures';

/** TDP-04 sponsor analytics and TSH-07 aggregate analytics against real PostgreSQL. Synthetic data only; every figure is checked against canonical records. */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');
const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/v1/*', auditTrail, cashierScopeGuard);
app.route('/api/v1/platform/shuffle', platformShuffleRoutes);
app.route('/api/v1/platform/drops', platformDropsRoutes);
app.onError(errorHandler);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { data?: any; error?: { code: string } };
async function get(path: string, token: string | undefined, flags: { shuffle?: string | undefined; drops?: string | undefined } = { shuffle: 'true', drops: 'true' }): Promise<{ status: number } & Envelope> {
  const pending: Promise<unknown>[] = []; const headers = new Headers(); if (token) headers.set('Authorization', `Bearer ${token}`);
  const env = { HYPERDRIVE: { connectionString: process.env.APP_RUNTIME_DATABASE_URL ?? databaseUrl }, JWT_ACCESS_SECRET: SECRET, TENTASHIP_SHUFFLE_ENABLED: flags.shuffle, TENTASHIP_DROPS_ENABLED: flags.drops } as unknown as Bindings;
  const res = await app.request(`/api/v1/platform/${path}`, { method: 'GET', headers }, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} });
  await Promise.all(pending); const text = await res.text(); let parsed: Envelope = {}; try { parsed = text ? (JSON.parse(text) as Envelope) : {}; } catch { /* 404 */ }
  return { status: res.status, ...parsed };
}

describe.skipIf(!databaseUrl)('TDP-04 / TSH-07 analytics (real PostgreSQL)', () => {
  let client: Client; let f: ReturnType<typeof makeFixtures>; let admin: { id: string; token: string }; let reviewer: { id: string; token: string }; let plain: { id: string; token: string };
  let bizA: string; let bizB: string; let rule: string; let analytics: TentashipAnalytics;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl }); await client.connect(); f = makeFixtures(client); analytics = new TentashipAnalytics(f.db);
    admin = await f.user('an-admin'); reviewer = await f.user('an-reviewer'); plain = await f.user('an-plain', false);
    bizA = await f.business('an-a'); bizB = await f.business('an-b');
    await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`);
    rule = await f.rule(admin.id);
  });
  afterAll(async () => { await f.q(`UPDATE qualification_rule_versions SET approval_state='retired', retired_at=now() WHERE approval_state <> 'retired'`).catch(() => undefined); await client?.end(); });

  it('Drops metrics equal the canonical records and every definition is documented; collection completion is unavailable (not zero) before any allocation', async () => {
    const empty = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: bizA, ruleId: rule, quantity: 4 });
    const e = await analytics.dropSponsorship(empty.sponsorshipId);
    expect(e.metrics).toMatchObject({ total: 4, reserved: 0, allocated: 0, collected: 0, allocationsExpired: 0, available: 4, holdsReleased: 0, holdsExpired: 0, outstandingCollection: 0, reconciled: true });
    expect(e.metrics!.collectionCompletionRate).toEqual({ available: false, reason: 'NO_ALLOCATION_YET' });

    const d = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: bizA, ruleId: rule, quantity: 5, reserve: 4, allocate: 3 });
    await f.drops.collect(d.reservationIds[0]!, f.ctx(reviewer.id));
    await f.drops.release(d.reservationIds[3]!, 'synthetic release', f.ctx(reviewer.id)); // the one still-reserved hold
    const short = await f.drops.reserve(d.sponsorshipId, await f.customer({ businessId: bizA, purchase: true }), new Date(Date.now() + 1200), f.ctx(reviewer.id));
    await new Promise((r) => setTimeout(r, 1500));
    await f.drops.expireDue(d.sponsorshipId, f.ctx(reviewer.id));
    expect(short.created).toBe(true);
    const m = (await analytics.dropSponsorship(d.sponsorshipId)).metrics!;
    expect(m).toMatchObject({ total: 5, reserved: 0, allocated: 2, collected: 1, allocationsExpired: 0, available: 2, holdsReleased: 1, holdsExpired: 1, outstandingCollection: 2, reconciled: true });
    expect(m.collectionCompletionRate).toBeCloseTo(1 / 3, 10);
    // independent recomputation from the raw reservation table
    const raw = await f.q(`SELECT status, count(*)::int n FROM drop_reservations WHERE sponsorship_id = $1 GROUP BY status`, [d.sponsorshipId]);
    const by = (s: string) => Number(raw.find((r) => r.status === s)?.n ?? 0);
    expect(by('allocated')).toBe(m.allocated); expect(by('collected')).toBe(m.collected); expect(by('released')).toBe(m.holdsReleased);
    expect(Object.keys(m).sort()).toEqual(Object.keys(DROP_METRIC_DEFINITIONS).sort()); // every reported metric has a documented definition and vice versa
    // an uncollected allocation after the window: counted as expired, never returned to the pool, completion rate uses units ever allocated
    const x = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: bizA, ruleId: rule, quantity: 2, reserve: 2, allocate: 2, collectionWindowEndMs: 1500 });
    await f.drops.collect(x.reservationIds[0]!, f.ctx(reviewer.id));
    await new Promise((r) => setTimeout(r, 1800)); await f.drops.expireDue(x.sponsorshipId, f.ctx(reviewer.id));
    const xm = (await analytics.dropSponsorship(x.sponsorshipId)).metrics!;
    expect(xm).toMatchObject({ total: 2, collected: 1, allocated: 0, allocationsExpired: 1, available: 0, outstandingCollection: 0, reconciled: true });
    expect(xm.collectionCompletionRate).toBe(0.5);
  });

  it('platform routes: generic 404 when the control is not exactly "true", admin only, definitions served, cashier/plain denied', async () => {
    const d = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: bizA, ruleId: rule, quantity: 2, reserve: 1 });
    expect((await get(`drops/sponsorships/${d.sponsorshipId}/analytics`, admin.token, { drops: 'false', shuffle: 'true' })).status).toBe(404);
    expect((await get(`drops/sponsorships/${d.sponsorshipId}/analytics`, admin.token, { drops: undefined })).status).toBe(404);
    expect((await get(`drops/sponsorships/${d.sponsorshipId}/analytics`, undefined)).status).toBe(401);
    expect((await get(`drops/sponsorships/${d.sponsorshipId}/analytics`, plain.token)).status).toBe(403);
    const ok = await get(`drops/sponsorships/${d.sponsorshipId}/analytics`, admin.token); expect(ok.status).toBe(200); expect(ok.data.metrics.reserved).toBe(1);
    expect(JSON.stringify(ok.data)).not.toMatch(/customer/i); // no customer identity in any analytics payload
    expect((await get('drops/metric-definitions', admin.token)).data).toEqual(DROP_METRIC_DEFINITIONS);
    expect((await get('shuffle/metric-definitions', admin.token)).data).toEqual(SHUFFLE_METRIC_DEFINITIONS);
    expect((await get('shuffle/metric-definitions', admin.token, { shuffle: 'true', drops: undefined })).status).toBe(200); // independent controls
    expect((await get('drops/metric-definitions', admin.token, { shuffle: 'true', drops: undefined })).status).toBe(404);
  });

  it('sponsor-scoped view (internal service): tenant-bound, explicit threshold required, all-or-nothing suppression so differencing cannot recover hidden values', async () => {
    const d = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: bizA, ruleId: rule, quantity: 10, reserve: 2, allocate: 1 });
    await expect(analytics.dropSponsorshipForBusiness(bizB, d.sponsorshipId, { minimumGroupSize: 3 })).rejects.toMatchObject({ code: 'SPONSORSHIP_NOT_FOUND' }); // another business: indistinguishable from missing
    await expect(analytics.dropSponsorshipForBusiness(bizA, d.sponsorshipId, { minimumGroupSize: 0 })).rejects.toMatchObject({ code: 'THRESHOLD_REQUIRED' });
    await expect(analytics.dropSponsorshipForBusiness(bizA, d.sponsorshipId, {} as never)).rejects.toMatchObject({ code: 'THRESHOLD_REQUIRED' });
    const hidden = await analytics.dropSponsorshipForBusiness(bizA, d.sponsorshipId, { minimumGroupSize: 5 });
    const m = hidden.metrics as Record<string, unknown>;
    expect(m.total).toBe(10); // the sponsor's own supply is not customer-derived
    for (const k of ['reserved', 'allocated', 'collected', 'allocationsExpired', 'available', 'holdsReleased', 'holdsExpired', 'outstandingCollection', 'collectionCompletionRate']) expect(m[k], k).toEqual({ available: false, reason: 'SUPPRESSED_SMALL_GROUP' });
    const shown = await analytics.dropSponsorshipForBusiness(bizA, d.sponsorshipId, { minimumGroupSize: 2 });
    expect(shown.metrics).toMatchObject({ total: 10, reserved: 1, allocated: 1, available: 8 });
    const none = await f.dropScenario({ creatorId: admin.id, reviewerId: reviewer.id, businessId: bizA, ruleId: rule, quantity: 3 });
    expect((await analytics.dropSponsorshipForBusiness(bizA, none.sponsorshipId, { minimumGroupSize: 50 })).metrics).toMatchObject({ reserved: 0, available: 3 }); // nothing to disclose
    const draft = await f.drops.create({ key: f.key('dp'), businessId: bizA, productName: 'x', description: 'y', quantityTotal: 1, collectionMethod: 'm', collectionLocation: 'l', collectionWindowStart: new Date(Date.now() - 1000), collectionWindowEnd: new Date(Date.now() + 86_400_000), offerExpiresAt: new Date(Date.now() + 86_400_000), qualificationRuleVersionId: rule }, f.ctx(admin.id));
    expect(await analytics.dropSponsorship(draft.sponsorship.id)).toMatchObject({ metrics: null, reason: 'NO_INVENTORY_UNTIL_APPROVED' });
  });

  it('Shuffle analytics keep the lifecycle events DISTINCT; unsupported metrics are unavailable (never zero); governance counts appear for the platform view only', async () => {
    const s = await f.shuffleScenario({ creatorId: admin.id, businessId: bizA, ruleId: rule, entries: 3, min: 1 });
    const mk = async () => { const cid = await f.customer({ businessId: bizA, purchase: true }); await f.shuffle.takeEligibilitySnapshot(s.versionId, cid, f.ctx(admin.id)); return cid; };
    const decl = await mk(); const dInv = await f.part.issueInvitation(s.versionId, decl, new Date(Date.now() + 3_600_000), f.ctx(admin.id)); await f.part.decline(dInv.invitation.id, f.ctx(admin.id));
    const wd = await mk(); const wInv = await f.part.issueInvitation(s.versionId, wd, new Date(Date.now() + 3_600_000), f.ctx(admin.id));
    await f.part.accept(wInv.invitation.id, { termsVersion: s.version.termsVersion, disclosureHash: s.version.disclosureHash }, f.ctx(admin.id));
    await f.part.withdraw(wInv.invitation.id, 'qualification invalidated', f.ctx(admin.id));
    await mk(); // eligible but never invited
    const nq = await f.customer(); await f.shuffle.takeEligibilitySnapshot(s.versionId, nq, f.ctx(admin.id)); // not eligible
    const a = await get(`shuffle/versions/${s.versionId}/analytics`, admin.token); expect(a.status, JSON.stringify(a)).toBe(200);
    const m = a.data.metrics;
    expect(m).toMatchObject({ eligibleSnapshots: 6, notEligibleSnapshots: 1, invitationsIssued: 5, invitationsAccepted: 4, invitationsDeclined: 1, invitationsExpired: 0, invitationsWithdrawn: 1, participationRecorded: 4, participantsAdmitted: 3, entriesCancelled: 1 });
    expect(m.participantsSelected).toEqual({ available: false, reason: 'SELECTION_NOT_RECORDED' });
    expect(m.eligibleSnapshots).not.toBe(m.invitationsIssued); expect(m.invitationsIssued).not.toBe(m.participationRecorded); expect(m.invitationsAccepted).not.toBe(m.participantsAdmitted); // different events
    for (const k of ['allocationRecorded', 'rewardCollected']) expect(m[k]).toEqual({ available: false, reason: 'NO_SHUFFLE_ALLOCATION_LINK' });
    for (const k of ['revenueAttribution', 'returnOnAdSpend', 'customerLifetimeValue', 'incrementalSales', 'sponsorProfitability']) expect(m[k], k).toEqual({ available: false, reason: 'NOT_SUPPORTED_BY_EVIDENCE' });
    expect(Object.keys(m).sort()).toEqual(Object.keys(SHUFFLE_METRIC_DEFINITIONS).sort());
    await f.part.runSyntheticSelection(s.versionId, 2, f.ctx(admin.id));
    expect((await get(`shuffle/versions/${s.versionId}/analytics`, admin.token)).data.metrics.participantsSelected).toBe(2);
    const inner = await analytics.shuffleVersion(s.versionId, { includeGovernance: false });
    expect(inner.metrics.governanceCases).toEqual({ available: false, reason: 'NOT_AUTHORIZED_FOR_THIS_VIEW' });
    expect(JSON.stringify(a.data)).not.toMatch(/customer_id|customerId|phone|email/i); // aggregate only: no individual is identifiable
    expect((await get(`shuffle/versions/${s.versionId}/analytics`, admin.token, { shuffle: 'false', drops: 'true' })).status).toBe(404);
  });
});
