import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import type { FeedbackFilterInput } from '@echo-grid-feedback/shared-types';

/**
 * Verifies Continuing Development S5-B's `hasOpenFraudSignal` filter -- the
 * "Suspected fraud" saved view -- against a real database. This is the one
 * part of S5-B that neither typecheck nor a fake-repository unit test can
 * reach, and it is not a hypothetical gap: the first version of the filter
 * was broken, and this file is what found it.
 *
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------
 * S5-B shipped the condition as a raw `sql` template holding a CORRELATED
 * subquery:
 *
 *   sql`EXISTS (SELECT 1 FROM ${fraudSignals}
 *               WHERE ${fraudSignals.feedbackId} = ${feedback.id} ...)`
 *
 * Nothing type-checks the inside of a raw template, and this one was
 * interpolated into a query built by drizzle's RELATIONAL query builder
 * (`db.query.feedback.findMany`), which aliases its target table. The
 * hand-written `${feedback.id}` did not resolve against that alias, and
 * Postgres raised 42P01 ("missing FROM-clause entry") -- a 500 on the saved
 * view, invisible until a human opened the tab. Fixed in "Fix fraud-signal
 * feedback filter aliasing" by building the subquery through the query
 * builder so drizzle emits references that match its own outer query.
 *
 * Only executing the query could have told us. Typecheck passed on the
 * broken version; so did every unit test.
 *
 * WHY A FAKE CANNOT SUBSTITUTE
 * ---------------------------------------------------------------------
 * The fake repository in feedback.service.test.ts implements this filter as
 * a JavaScript `Set.has` over ids it was handed. A faithful model of the
 * INTENT and a useless model of the SQL: it cannot express a subquery, a
 * status column, row multiplicity, or tenant scoping.
 *
 * Test 5 ("two open signals") is why this is a semi-join and not a join: a
 * joined row comes back once per matching signal, inflating the page and
 * breaking `hasMore`. Test 8 covers the businessId scoping that keeps the
 * subquery bounded to one tenant. A fake cannot fail either; a real
 * database can.
 */
describe.skipIf(!process.env.DATABASE_URL)('feedback hasOpenFraudSignal filter (integration)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let businessId: string;
  let branchId: string;
  let qrCodeId: string;

  /** Ids of the rows each scenario owns, so assertions can name them
   * instead of relying on ordering or on the business having nothing else
   * in it. */
  let withOpenSignalId: string;
  let withNoSignalId: string;
  let withReviewedSignalId: string;
  let withDismissedSignalId: string;
  let withTwoOpenSignalsId: string;

  /** A SECOND tenant, with its own flagged feedback. Exists only so test 8
   * can prove this business's results never include it. */
  let otherBusinessId: string;
  let otherBusinessFlaggedId: string;

  /**
   * listWithFilters takes the POST-parse filter shape, where the four
   * paging/sorting fields are no longer optional (feedbackFilterSchema
   * gives them defaults, which makes them required on the inferred output
   * type). Supplying them once here keeps each test to the one field it is
   * actually about.
   */
  function baseFilters(
    overrides: { hasOpenFraudSignal?: boolean; search?: string; limit?: number } = {},
  ): Omit<FeedbackFilterInput, 'savedView'> {
    return {
      branchId,
      sortBy: 'createdAt',
      sortDirection: 'desc',
      // Computed with `??` rather than spread over: `limit`/`offset`/`sortBy`
      // are REQUIRED on this type (feedbackFilterSchema defaults them, which
      // makes them non-optional on the inferred output), and spreading a
      // partial over a required field is the precise shape
      // exactOptionalPropertyTypes rejects. The two genuinely optional
      // fields use the conditional-spread idiom this codebase already uses
      // (see FeedbackService.submit's deviceHash) so an absent override
      // stays absent rather than becoming an explicit `undefined`.
      limit: overrides.limit ?? 25,
      offset: 0,
      ...(overrides.hasOpenFraudSignal !== undefined
        ? { hasOpenFraudSignal: overrides.hasOpenFraudSignal }
        : {}),
      ...(overrides.search !== undefined ? { search: overrides.search } : {}),
    };
  }

  /** A signal shaped like the one S5-B's detector actually writes
   * (qr.routes.ts) -- same signalType/reasonCode/severity, so this suite
   * exercises the real row shape rather than a synthetic one. */
  async function openSignalFor(feedbackId: string) {
    return repos.fraudSignals.create({
      businessId,
      branchId,
      feedbackId,
      signalType: 'duplicate_text',
      reasonCode: 'repeated_exact_text',
      severity: 'low',
    });
  }

  async function newFeedback(comment: string) {
    const row = await repos.feedback.create({ businessId, branchId, qrCodeId, rating: 2, comment });
    return row.id;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    repos = createRepositories(buildDb(client));

    const business = await repos.businesses.create({
      name: 'Fraud Signal Filter Test Business',
      slug: `fraud-filter-test-${crypto.randomUUID()}`,
    });
    businessId = business.id;

    const branch = await repos.branches.create({
      businessId,
      name: 'Main',
      slug: `fraud-filter-branch-${crypto.randomUUID()}`,
    });
    branchId = branch.id;

    const qrCode = await repos.qrCodes.create({ businessId, branchId });
    qrCodeId = qrCode.id;

    // One feedback row per scenario, all in the same branch so branchId
    // scoping never accidentally does the filtering's work for it.
    withOpenSignalId = await newFeedback('has one open signal');
    withNoSignalId = await newFeedback('has no signal at all');
    withReviewedSignalId = await newFeedback('signal already reviewed');
    withDismissedSignalId = await newFeedback('signal already dismissed');
    withTwoOpenSignalsId = await newFeedback('two independent open signals');

    await openSignalFor(withOpenSignalId);

    const reviewed = await openSignalFor(withReviewedSignalId);
    await repos.fraudSignals.markReviewed(reviewed.id, businessId, businessId);

    const dismissed = await openSignalFor(withDismissedSignalId);
    await repos.fraudSignals.markDismissed(dismissed.id, businessId, businessId);

    // Two genuinely independent findings on one row -- exactly the case the
    // schema's own comment calls out (duplicate text AND a velocity breach).
    await openSignalFor(withTwoOpenSignalsId);
    await repos.fraudSignals.create({
      businessId,
      branchId,
      feedbackId: withTwoOpenSignalsId,
      signalType: 'device_velocity',
      reasonCode: 'device_submission_rate_exceeded',
      severity: 'medium',
    });

    // A second tenant carrying its own OPEN signal. The subquery that backs
    // this filter is scoped on businessId; without a foreign tenant in the
    // table at all, that scoping would be untested and its removal would go
    // unnoticed.
    const otherBusiness = await repos.businesses.create({
      name: 'Fraud Signal Filter Other Tenant',
      slug: `fraud-filter-other-${crypto.randomUUID()}`,
    });
    otherBusinessId = otherBusiness.id;

    const otherBranch = await repos.branches.create({
      businessId: otherBusinessId,
      name: 'Other Main',
      slug: `fraud-filter-other-branch-${crypto.randomUUID()}`,
    });
    const otherQr = await repos.qrCodes.create({
      businessId: otherBusinessId,
      branchId: otherBranch.id,
    });
    const otherFeedback = await repos.feedback.create({
      businessId: otherBusinessId,
      branchId: otherBranch.id,
      qrCodeId: otherQr.id,
      rating: 1,
      comment: 'another tenant, flagged',
    });
    otherBusinessFlaggedId = otherFeedback.id;

    await repos.fraudSignals.create({
      businessId: otherBusinessId,
      branchId: otherBranch.id,
      feedbackId: otherBusinessFlaggedId,
      signalType: 'duplicate_text',
      reasonCode: 'repeated_exact_text',
      severity: 'low',
    });
  });

  afterAll(async () => {
    // Soft-delete only, matching every other suite here. fraud_signals and
    // feedback both cascade on a real business delete, but nothing
    // hard-deletes the business itself -- point DATABASE_URL at a
    // scratch/dev database only.
    await repos.businesses.softDelete(businessId, businessId);
    await repos.businesses.softDelete(otherBusinessId, otherBusinessId);
    await client.end();
  });

  it('executes at all -- the subquery resolves against the relational query builder\'s own aliasing', async () => {
    // Deliberately the first and simplest assertion in the file, and the one
    // that actually fired: on the original raw-`sql` correlated EXISTS this
    // line threw 42P01 and every test below was noise. Asserting only "it
    // returned rows" keeps that failure unambiguous -- a broken query cannot
    // be mistaken for a wrong result.
    const result = await repos.feedback.listWithFilters(businessId, baseFilters({ hasOpenFraudSignal: true }));
    expect(Array.isArray(result.items)).toBe(true);
  });

  it('returns a feedback row that has an open signal', async () => {
    const { items } = await repos.feedback.listWithFilters(
      businessId,
      baseFilters({ hasOpenFraudSignal: true }),
    );
    expect(items.map((i) => i.id)).toContain(withOpenSignalId);
  });

  it('excludes a row with no signal at all', async () => {
    const { items } = await repos.feedback.listWithFilters(
      businessId,
      baseFilters({ hasOpenFraudSignal: true }),
    );
    expect(items.map((i) => i.id)).not.toContain(withNoSignalId);
  });

  it('excludes rows whose only signal is reviewed or dismissed -- the view is a work queue, not a history', async () => {
    const { items } = await repos.feedback.listWithFilters(
      businessId,
      baseFilters({ hasOpenFraudSignal: true }),
    );
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain(withReviewedSignalId);
    expect(ids).not.toContain(withDismissedSignalId);
  });

  it('returns a row carrying TWO open signals exactly once -- the reason this is a semi-join and not a join', async () => {
    const { items } = await repos.feedback.listWithFilters(
      businessId,
      baseFilters({ hasOpenFraudSignal: true }),
    );
    const occurrences = items.filter((i) => i.id === withTwoOpenSignalsId).length;
    expect(occurrences).toBe(1);
  });

  it('returns exactly the two flagged rows and nothing else -- the filter, not the fixture, is doing the work', async () => {
    const flagged = await repos.feedback.listWithFilters(
      businessId,
      baseFilters({ hasOpenFraudSignal: true }),
    );
    expect(new Set(flagged.items.map((i) => i.id))).toEqual(
      new Set([withOpenSignalId, withTwoOpenSignalsId]),
    );

    // Same branch, filter off: all five rows are present and reachable, so
    // the four exclusions above are the filter's doing and not a missing or
    // mis-scoped fixture.
    const unfiltered = await repos.feedback.listWithFilters(businessId, baseFilters());
    expect(new Set(unfiltered.items.map((i) => i.id))).toEqual(
      new Set([
        withOpenSignalId,
        withNoSignalId,
        withReviewedSignalId,
        withDismissedSignalId,
        withTwoOpenSignalsId,
      ]),
    );
  });

  it('composes with another filter rather than replacing it -- a text search narrows the flagged set', async () => {
    // Both flagged rows carry an open signal; only one of them contains
    // this phrase, so the result proves the subquery condition is ANDed
    // alongside its siblings rather than built in a way that drops them out
    // of the `and(...conditions)` list.
    const { items } = await repos.feedback.listWithFilters(
      businessId,
      baseFilters({ hasOpenFraudSignal: true, search: 'two independent' }),
    );
    expect(items.map((i) => i.id)).toEqual([withTwoOpenSignalsId]);
  });

  it('keeps hasMore honest under the filter -- a page of 1 over 2 flagged rows reports more', async () => {
    // The multiplicity bug a join would have introduced shows up here too:
    // three joined rows for two feedback rows would make a limit-2 page
    // claim hasMore when there is nothing more to fetch.
    const firstPage = await repos.feedback.listWithFilters(
      businessId,
      baseFilters({ hasOpenFraudSignal: true, limit: 1 }),
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);

    const fullPage = await repos.feedback.listWithFilters(
      businessId,
      baseFilters({ hasOpenFraudSignal: true, limit: 2 }),
    );
    expect(fullPage.items).toHaveLength(2);
    expect(fullPage.hasMore).toBe(false);
  });

  it("is scoped per tenant in both directions -- neither business sees the other's flagged feedback", async () => {
    // Deliberately NO branchId here, unlike every test above. baseFilters()
    // always sets one, and the other tenant lives in a different branch, so
    // with it the BRANCH filter would do the excluding and the businessId
    // scoping would go untested. Dropping it leaves businessId as the only
    // thing separating the two tenants -- which is the point.
    const unscopedByBranch: Omit<FeedbackFilterInput, 'savedView'> = {
      hasOpenFraudSignal: true,
      sortBy: 'createdAt',
      sortDirection: 'desc',
      limit: 100,
      offset: 0,
    };

    const mine = await repos.feedback.listWithFilters(businessId, unscopedByBranch);
    const mineIds = mine.items.map((i) => i.id);
    expect(mineIds).toContain(withOpenSignalId);
    expect(mineIds).not.toContain(otherBusinessFlaggedId);

    // The mirror matters as much as the exclusion. The subquery backing this
    // filter is itself scoped on businessId; a wrong value there would not
    // leak anything, it would silently return NOTHING for the tenant whose
    // signals are real. Only querying as the other business catches that.
    const theirs = await repos.feedback.listWithFilters(otherBusinessId, unscopedByBranch);
    expect(theirs.items.map((i) => i.id)).toEqual([otherBusinessFlaggedId]);
  });
});
