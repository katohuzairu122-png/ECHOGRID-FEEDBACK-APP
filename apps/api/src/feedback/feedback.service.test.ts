import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackService } from './feedback.service';
import type { Feedback, NewFeedback } from '../repositories/feedback.repository';
import type { QrCode } from '../repositories/qr-code.repository';
import type { CriticalIncident, NewCriticalIncident } from '../repositories/critical-incident.repository';

/** Only `create` is ever called from FeedbackService.submit -- a minimal
 * fake, not a full CriticalIncidentRepository stand-in. */
function createFakeCriticalIncidentRepo() {
  const items: CriticalIncident[] = [];
  return {
    items,
    async create(input: NewCriticalIncident): Promise<CriticalIncident> {
      const item: CriticalIncident = {
        id: crypto.randomUUID(),
        businessId: input.businessId,
        branchId: input.branchId,
        feedbackId: input.feedbackId,
        matchedSignals: input.matchedSignals,
        acknowledgedAt: null,
        acknowledgedBy: null,
        escalatedAt: null,
        createdAt: new Date(),
      };
      items.push(item);
      return item;
    },
  };
}

/** Same fake-repo style as branch.service.test.ts. */
function createFakeFeedbackRepo() {
  const items = new Map<string, Feedback>();

  return {
    async findById(id: string, businessId: string): Promise<Feedback | undefined> {
      const item = items.get(id);
      return item && item.businessId === businessId && !item.isDeleted ? item : undefined;
    },
    async listForBusiness(
      businessId: string,
      options: { branchId?: string; limit?: number; offset?: number } = {},
    ): Promise<Feedback[]> {
      let all = [...items.values()].filter((i) => i.businessId === businessId && !i.isDeleted);
      if (options.branchId) all = all.filter((i) => i.branchId === options.branchId);
      const offset = options.offset ?? 0;
      const limit = options.limit ?? all.length;
      return all.slice(offset, offset + limit);
    },
    async create(input: NewFeedback): Promise<Feedback> {
      const item: Feedback = {
        id: crypto.randomUUID(),
        businessId: input.businessId,
        branchId: input.branchId,
        qrCodeId: input.qrCodeId,
        rating: input.rating,
        comment: input.comment ?? null,
        customerName: input.customerName ?? null,
        customerEmail: input.customerEmail ?? null,
        customerPhone: input.customerPhone ?? null,
        followUpQuestion: input.followUpQuestion ?? null,
        followUpAnswer: input.followUpAnswer ?? null,
        status: input.status ?? 'new',
        sentiment: input.sentiment ?? null,
        sentimentScore: input.sentimentScore ?? null,
        analysisStatus: input.analysisStatus ?? 'pending',
        analyzedAt: input.analyzedAt ?? null,
        category: input.category ?? null,
        urgency: input.urgency ?? null,
        assignedTo: input.assignedTo ?? null,
        normalizedTextHash: input.normalizedTextHash ?? null,
        isDuplicateText: input.isDuplicateText ?? false,
        createdAt: new Date(),
        createdBy: input.createdBy ?? null,
        updatedAt: new Date(),
        updatedBy: input.updatedBy ?? null,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
      };
      items.set(item.id, item);
      return item;
    },
    async markReviewed(
      id: string,
      businessId: string,
      updatedBy: string,
    ): Promise<Feedback | undefined> {
      const item = items.get(id);
      if (!item || item.businessId !== businessId || item.isDeleted) return undefined;
      item.status = 'reviewed';
      item.updatedBy = updatedBy;
      item.updatedAt = new Date();
      return item;
    },
    // Continuing Development S4 Block 10. Mirrors the real repository's
    // behaviour that the service's own tests depend on: the terminal
    // 'manual' status, and nulling sentimentScore whenever sentiment is set.
    async classifyManually(
      id: string,
      businessId: string,
      patch: { category?: string; urgency?: string; sentiment?: string },
      updatedBy: string,
    ): Promise<Feedback | undefined> {
      const item = items.get(id);
      if (!item || item.businessId !== businessId || item.isDeleted) return undefined;
      if (patch.category !== undefined) item.category = patch.category;
      if (patch.urgency !== undefined) item.urgency = patch.urgency;
      if (patch.sentiment !== undefined) {
        item.sentiment = patch.sentiment;
        item.sentimentScore = null;
      }
      item.analysisStatus = 'manual';
      item.analyzedAt = new Date();
      item.updatedBy = updatedBy;
      item.updatedAt = new Date();
      return item;
    },
    async softDelete(id: string, businessId: string, deletedBy: string): Promise<void> {
      const item = items.get(id);
      if (item && item.businessId === businessId) {
        item.isDeleted = true;
        item.deletedAt = new Date();
        item.deletedBy = deletedBy;
      }
    },
    async assign(
      id: string,
      businessId: string,
      assignedTo: string | null,
      updatedBy: string,
    ): Promise<Feedback | undefined> {
      const item = items.get(id);
      if (!item || item.businessId !== businessId || item.isDeleted) return undefined;
      item.assignedTo = assignedTo;
      item.updatedBy = updatedBy;
      item.updatedAt = new Date();
      return item;
    },
    async bulkAssign(
      ids: string[],
      businessId: string,
      assignedTo: string | null,
      updatedBy: string,
    ): Promise<Feedback[]> {
      const updated: Feedback[] = [];
      for (const id of ids) {
        const item = items.get(id);
        if (!item || item.businessId !== businessId || item.isDeleted) continue;
        item.assignedTo = assignedTo;
        item.updatedBy = updatedBy;
        item.updatedAt = new Date();
        updated.push(item);
      }
      return updated;
    },
    async bulkMarkReviewed(ids: string[], businessId: string, updatedBy: string): Promise<Feedback[]> {
      const updated: Feedback[] = [];
      for (const id of ids) {
        const item = items.get(id);
        if (!item || item.businessId !== businessId || item.isDeleted) continue;
        item.status = 'reviewed';
        item.updatedBy = updatedBy;
        item.updatedAt = new Date();
        updated.push(item);
      }
      return updated;
    },
    /** In-memory stand-in for the real query's ORDER BY createdAt DESC
     * LIMIT 1 -- same businessId+branchId+hash scoping FeedbackService
     * relies on for exact-duplicate detection. */
    async findMostRecentByNormalizedHash(
      businessId: string,
      branchId: string,
      normalizedTextHash: string,
    ): Promise<Feedback | undefined> {
      const matches = [...items.values()]
        .filter(
          (i) =>
            i.businessId === businessId &&
            i.branchId === branchId &&
            i.normalizedTextHash === normalizedTextHash &&
            !i.isDeleted,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return matches[0];
    },
    /** In-memory stand-in for FeedbackRepository.listWithFilters -- only
     * the fields this test file actually exercises are filtered on; good
     * enough to verify FeedbackService.listWithFilters' saved-view-merge
     * logic without re-implementing the real SQL query. */
    async listWithFilters(
      businessId: string,
      filters: {
        branchId?: string;
        category?: string[];
        urgency?: string[];
        sentiment?: string[];
        status?: string[];
        analysisStatus?: string[];
        assignedTo?: string;
        unassigned?: boolean;
        followUpRequired?: boolean;
        limit?: number;
        offset?: number;
      },
    ): Promise<{ items: Feedback[]; hasMore: boolean }> {
      let all = [...items.values()].filter((i) => i.businessId === businessId && !i.isDeleted);
      if (filters.branchId) all = all.filter((i) => i.branchId === filters.branchId);
      if (filters.category?.length) all = all.filter((i) => i.category && filters.category!.includes(i.category));
      if (filters.urgency?.length) all = all.filter((i) => i.urgency && filters.urgency!.includes(i.urgency));
      if (filters.sentiment?.length) all = all.filter((i) => i.sentiment && filters.sentiment!.includes(i.sentiment));
      if (filters.status?.length) all = all.filter((i) => filters.status!.includes(i.status));
      if (filters.analysisStatus?.length) all = all.filter((i) => filters.analysisStatus!.includes(i.analysisStatus));
      if (filters.assignedTo) all = all.filter((i) => i.assignedTo === filters.assignedTo);
      if (filters.unassigned) all = all.filter((i) => i.assignedTo === null);
      if (filters.followUpRequired) all = all.filter((i) => i.followUpQuestion && !i.followUpAnswer);

      const limit = filters.limit ?? 25;
      const offset = filters.offset ?? 0;
      const page = all.slice(offset, offset + limit + 1);
      return { items: page.slice(0, limit), hasMore: page.length > limit };
    },
  };
}

const BUSINESS_A = 'business-a';
const BRANCH_A = 'branch-a';
const ACTOR = 'actor-user-id';
const QR_CODE: QrCode = {
  id: 'qr-1',
  businessId: BUSINESS_A,
  branchId: BRANCH_A,
  type: 'feedback',
  status: 'active',
  createdAt: new Date(),
  createdBy: null,
  updatedAt: new Date(),
  updatedBy: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
};

describe('FeedbackService', () => {
  let repos: {
    feedback: ReturnType<typeof createFakeFeedbackRepo>;
    criticalIncidents: ReturnType<typeof createFakeCriticalIncidentRepo>;
  };
  let service: FeedbackService;

  beforeEach(() => {
    repos = { feedback: createFakeFeedbackRepo(), criticalIncidents: createFakeCriticalIncidentRepo() };
    service = new FeedbackService(repos as unknown as ConstructorParameters<typeof FeedbackService>[0]);
  });

  it('submit creates a row scoped to the qr code’s business/branch, with no actor', async () => {
    const item = await service.submit(QR_CODE, { rating: 5, comment: 'Great!' });
    expect(item.businessId).toBe(BUSINESS_A);
    expect(item.branchId).toBe(BRANCH_A);
    expect(item.qrCodeId).toBe(QR_CODE.id);
    expect(item.rating).toBe(5);
    expect(item.status).toBe('new');
    expect(item.createdBy).toBeNull();
  });

  it('submit stores a follow-up answer only when paired with its question', async () => {
    const withPair = await service.submit(QR_CODE, {
      rating: 5,
      followUpQuestion: 'What made this great?',
      followUpAnswer: 'The staff were wonderful.',
    });
    expect(withPair.followUpQuestion).toBe('What made this great?');
    expect(withPair.followUpAnswer).toBe('The staff were wonderful.');

    // A tampered client sending an answer with no question -- the answer
    // must be dropped, never stored floating without its question.
    const withoutQuestion = await service.submit(QR_CODE, {
      rating: 5,
      followUpAnswer: 'This should never be stored.',
    });
    expect(withoutQuestion.followUpQuestion).toBeNull();
    expect(withoutQuestion.followUpAnswer).toBeNull();
  });

  it('listForBusiness returns only that business’s feedback', async () => {
    await service.submit(QR_CODE, { rating: 4 });
    await service.submit({ ...QR_CODE, businessId: 'business-b' }, { rating: 2 });

    const items = await service.listForBusiness(BUSINESS_A);
    expect(items).toHaveLength(1);
    expect(items[0]!.rating).toBe(4);
  });

  it('listForBusiness filters by branchId when given', async () => {
    await service.submit(QR_CODE, { rating: 4 });
    await service.submit({ ...QR_CODE, branchId: 'branch-b' }, { rating: 2 });

    const items = await service.listForBusiness(BUSINESS_A, { branchId: BRANCH_A });
    expect(items).toHaveLength(1);
    expect(items[0]!.branchId).toBe(BRANCH_A);
  });

  it('markReviewed transitions status and returns the updated row', async () => {
    const item = await service.submit(QR_CODE, { rating: 3 });
    const updated = await service.markReviewed(item.id, BUSINESS_A, ACTOR);
    expect(updated.status).toBe('reviewed');
  });

  it('markReviewed throws 404 for an unknown id', async () => {
    await expect(service.markReviewed('does-not-exist', BUSINESS_A, ACTOR)).rejects.toMatchObject({
      code: 'FEEDBACK_NOT_FOUND',
      status: 404,
    });
  });

  it('remove soft-deletes: the item no longer appears in listForBusiness', async () => {
    const item = await service.submit(QR_CODE, { rating: 1 });
    await service.remove(item.id, BUSINESS_A, ACTOR);

    expect(await service.listForBusiness(BUSINESS_A)).toHaveLength(0);
  });

  it('remove throws 404 for an unknown id rather than a silent no-op', async () => {
    await expect(service.remove('does-not-exist', BUSINESS_A, ACTOR)).rejects.toMatchObject({
      code: 'FEEDBACK_NOT_FOUND',
    });
  });

  it('submit stores an ordinary low rating with no urgency and no incident record', async () => {
    const item = await service.submit(QR_CODE, { rating: 1, comment: 'Slow service and cold food.' });
    expect(item.urgency).toBeNull();
    expect(repos.criticalIncidents.items).toHaveLength(0);
  });

  it('submit sets P0_CRITICAL and creates an incident record for credible safety language', async () => {
    const item = await service.submit(QR_CODE, {
      rating: 1,
      comment: 'A customer just collapsed and is not breathing, someone call an ambulance!',
    });
    expect(item.urgency).toBe('P0_CRITICAL');
    expect(repos.criticalIncidents.items).toHaveLength(1);
    expect(repos.criticalIncidents.items[0]).toMatchObject({
      feedbackId: item.id,
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
    });
    expect(repos.criticalIncidents.items[0]!.matchedSignals).toContain('medical_emergency');
  });

  it('submit never blocks storage on critical detection -- the row exists even for the critical path', async () => {
    const item = await service.submit(QR_CODE, { rating: 1, comment: 'There is a fire in the kitchen!' });
    expect(item.id).toBeTruthy();
    expect(item.rating).toBe(1);
  });

  it('submit flags the second exact-text submission at the same branch as a duplicate, not the first', async () => {
    const first = await service.submit(QR_CODE, { rating: 2, comment: 'Cold food and slow service.' });
    const second = await service.submit(QR_CODE, { rating: 2, comment: 'Cold food and slow service.' });

    expect(first.isDuplicateText).toBe(false);
    expect(second.isDuplicateText).toBe(true);
  });

  it('submit treats case and whitespace differences as the same text for duplicate detection', async () => {
    await service.submit(QR_CODE, { rating: 2, comment: 'Cold food and slow service.' });
    const second = await service.submit(QR_CODE, { rating: 3, comment: '  COLD food   and slow service.  ' });

    expect(second.isDuplicateText).toBe(true);
  });

  it('submit never flags a duplicate across different branches of the same business', async () => {
    await service.submit(QR_CODE, { rating: 2, comment: 'Cold food and slow service.' });
    const otherBranch = await service.submit(
      { ...QR_CODE, branchId: 'branch-b' },
      { rating: 2, comment: 'Cold food and slow service.' },
    );

    expect(otherBranch.isDuplicateText).toBe(false);
  });

  it('submit never flags comment-less submissions as duplicates of each other', async () => {
    await service.submit(QR_CODE, { rating: 5 });
    const second = await service.submit(QR_CODE, { rating: 5 });

    expect(second.isDuplicateText).toBe(false);
  });

  it('assign sets assignedTo and throws 404 for an unknown id', async () => {
    const item = await service.submit(QR_CODE, { rating: 3 });
    const assigned = await service.assign(item.id, BUSINESS_A, ACTOR, ACTOR);
    expect(assigned.assignedTo).toBe(ACTOR);

    await expect(service.assign('missing', BUSINESS_A, ACTOR, ACTOR)).rejects.toMatchObject({
      code: 'FEEDBACK_NOT_FOUND',
    });
  });

  it('bulkAssign updates every valid id and silently skips ones from another business', async () => {
    const a = await service.submit(QR_CODE, { rating: 3 });
    const b = await service.submit(QR_CODE, { rating: 4 });
    const other = await service.submit({ ...QR_CODE, businessId: 'business-b' }, { rating: 2 });

    const updated = await service.bulkAssign([a.id, b.id, other.id], BUSINESS_A, ACTOR, ACTOR);

    expect(updated).toHaveLength(2);
    expect(updated.every((i) => i.assignedTo === ACTOR)).toBe(true);
  });

  it('bulkMarkReviewed transitions every valid id to reviewed', async () => {
    const a = await service.submit(QR_CODE, { rating: 3 });
    const b = await service.submit(QR_CODE, { rating: 4 });

    const updated = await service.bulkMarkReviewed([a.id, b.id], BUSINESS_A, ACTOR);

    expect(updated).toHaveLength(2);
    expect(updated.every((i) => i.status === 'reviewed')).toBe(true);
  });

  it('listWithFilters with no savedView just passes the caller\'s own filters through', async () => {
    await service.submit(QR_CODE, { rating: 1, comment: 'There is a fire!' }); // P0_CRITICAL
    await service.submit(QR_CODE, { rating: 5 });

    const result = await service.listWithFilters(BUSINESS_A, {
      urgency: ['P0_CRITICAL'],
      sortBy: 'createdAt',
      sortDirection: 'desc',
      limit: 25,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.urgency).toBe('P0_CRITICAL');
  });

  it('listWithFilters expands a savedView, and the caller\'s explicit filters override the preset', async () => {
    await service.submit(QR_CODE, { rating: 1, comment: 'There is a fire!' }); // P0_CRITICAL, branch-a
    await service.submit(
      { ...QR_CODE, branchId: 'branch-b' },
      { rating: 1, comment: 'There is a fire!' },
    ); // P0_CRITICAL, branch-b

    // "Critical now" alone -- both match.
    const both = await service.listWithFilters(BUSINESS_A, {
      savedView: 'critical_now',
      sortBy: 'createdAt',
      sortDirection: 'desc',
      limit: 25,
      offset: 0,
    });
    expect(both.items).toHaveLength(2);

    // "Critical now" narrowed to branch-a -- only one matches. branchId isn't
    // part of any saved-view preset, so this proves explicit filters compose
    // WITH the preset, not just override overlapping fields.
    const narrowed = await service.listWithFilters(BUSINESS_A, {
      savedView: 'critical_now',
      branchId: BRANCH_A,
      sortBy: 'createdAt',
      sortDirection: 'desc',
      limit: 25,
      offset: 0,
    });
    expect(narrowed.items).toHaveLength(1);
    expect(narrowed.items[0]!.branchId).toBe(BRANCH_A);
  });

  // --- Manual classification (Continuing Development S4 Block 10, S4.3) ---

  /** Rows are created through submit() like every other test here, then
   * nudged into the precondition state directly -- the fake's create()
   * stores and returns the same object reference, so mutating it is exactly
   * what a prior pipeline run would have left behind. */
  async function seedClassified(patch: Partial<Feedback> = {}) {
    const item = await service.submit(QR_CODE, { rating: 3, comment: 'Something went wrong.' });
    Object.assign(item, patch);
    return item;
  }

  it('classifyManually sets the fields a human supplied and marks the row terminal-manual', async () => {
    const item = await seedClassified({ analysisStatus: 'failed' });

    const updated = await service.classifyManually(
      item.id,
      BUSINESS_A,
      { category: 'staff_conduct', urgency: 'P1_HIGH' },
      ACTOR,
    );

    expect(updated.category).toBe('staff_conduct');
    expect(updated.urgency).toBe('P1_HIGH');
    // 'manual', never 'completed' -- the automated pipeline did not succeed
    // here, it failed, which is precisely why a human stepped in.
    expect(updated.analysisStatus).toBe('manual');
    expect(updated.analyzedAt).not.toBeNull();
    expect(updated.updatedBy).toBe(ACTOR);
  });

  /** The "Unclassified" saved view is analysisStatus IN ('pending','failed')
   * (feedback-saved-views.ts) -- a hand-classified row that kept 'failed'
   * would sit in that queue forever, the very queue the human just worked
   * through. */
  it("moves the row out of the Unclassified saved view's status set", async () => {
    const item = await seedClassified({ analysisStatus: 'failed' });

    const updated = await service.classifyManually(item.id, BUSINESS_A, { category: 'pricing' }, ACTOR);

    expect(['pending', 'failed']).not.toContain(updated.analysisStatus);
  });

  it('nulls sentimentScore when a human overrides sentiment -- a human judgment carries no model confidence', async () => {
    const item = await seedClassified({
      sentiment: 'positive',
      sentimentScore: 0.92,
      analysisStatus: 'completed',
    });

    const updated = await service.classifyManually(item.id, BUSINESS_A, { sentiment: 'negative' }, ACTOR);

    expect(updated.sentiment).toBe('negative');
    // A stale 0.92 beside a 'negative' label would leave score and label
    // disagreeing -- which feedback.ts's schema comment says must never
    // happen -- and would feed a fabricated confidence to the trend chart.
    expect(updated.sentimentScore).toBeNull();
  });

  it('leaves sentimentScore alone when the patch does not touch sentiment', async () => {
    const item = await seedClassified({
      sentiment: 'positive',
      sentimentScore: 0.92,
      analysisStatus: 'completed',
    });

    const updated = await service.classifyManually(item.id, BUSINESS_A, { urgency: 'P3_LOW' }, ACTOR);

    expect(updated.sentimentScore).toBe(0.92);
    expect(updated.sentiment).toBe('positive');
  });

  it('accepts a single field -- correcting only the urgency is a normal action', async () => {
    const item = await seedClassified({ category: 'pricing', analysisStatus: 'completed' });

    const updated = await service.classifyManually(item.id, BUSINESS_A, { urgency: 'P0_CRITICAL' }, ACTOR);

    expect(updated.urgency).toBe('P0_CRITICAL');
    // Untouched fields must survive: forcing a caller to re-send them would
    // invite overwriting good values with stale ones read minutes earlier.
    expect(updated.category).toBe('pricing');
  });

  it('rejects an empty patch rather than silently marking the row handled', async () => {
    const item = await seedClassified({ analysisStatus: 'failed' });

    await expect(service.classifyManually(item.id, BUSINESS_A, {}, ACTOR)).rejects.toMatchObject({
      code: 'EMPTY_CLASSIFICATION',
      status: 400,
    });
    // And the row must be left exactly as it was -- still stuck, not
    // quietly flipped to 'manual' with nothing actually classified.
    expect(item.analysisStatus).toBe('failed');
  });

  it('throws 404 for an unknown id', async () => {
    await expect(
      service.classifyManually('does-not-exist', BUSINESS_A, { category: 'pricing' }, ACTOR),
    ).rejects.toMatchObject({ code: 'FEEDBACK_NOT_FOUND', status: 404 });
  });

  it("throws 404 for another business's row -- tenant isolation", async () => {
    const item = await seedClassified({});

    await expect(
      service.classifyManually(item.id, 'business-b', { category: 'pricing' }, ACTOR),
    ).rejects.toMatchObject({ code: 'FEEDBACK_NOT_FOUND', status: 404 });
  });
});
