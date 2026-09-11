import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackService } from './feedback.service';
import type { Feedback, NewFeedback } from '../repositories/feedback.repository';
import type { QrCode } from '../repositories/qr-code.repository';
import type { CriticalIncident, NewCriticalIncident } from '../repositories/critical-incident.repository';
import type { ClassifyFeedbackInput } from '@echo-grid-feedback/shared-types';

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
  /** Stands in for the real query's correlated EXISTS against fraud_signals
   * (Continuing Development S5-B). Fraud signals live in their own table and
   * are written by qr.routes.ts, not by FeedbackService, so this fake models
   * only the one thing the service's saved-view merge depends on: whether a
   * given feedback row currently has an open signal. */
  const openFraudSignalFeedbackIds = new Set<string>();

  return {
    openFraudSignalFeedbackIds,
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
        duplicateTextCount: input.duplicateTextCount ?? 0,
        deviceHash: input.deviceHash ?? null,
        nearDuplicateCount: input.nearDuplicateCount ?? 0,
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
      patch: ClassifyFeedbackInput,
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
    /** In-memory stand-in for the real query (Continuing Development S5-C):
     * this device's most recent comments at this branch, newest first, capped
     * by the caller's own limit. Returns just the comment text, same
     * projection the real query selects. */
    async listRecentCommentsForDevice(
      businessId: string,
      branchId: string,
      deviceHash: string,
      since: Date,
      limit: number,
    ): Promise<(string | null)[]> {
      return [...items.values()]
        .filter(
          (i) =>
            i.businessId === businessId &&
            i.branchId === branchId &&
            i.deviceHash === deviceHash &&
            !i.isDeleted &&
            i.createdAt >= since,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((i) => i.comment);
    },
    /** In-memory stand-in for the real COUNT(*) query (Continuing
     * Development S5-A) -- same business+branch+hash scoping and isDeleted
     * exclusion as findMostRecentByNormalizedHash above, plus the mandatory
     * `since` window the real signature requires. */
    async countByNormalizedHash(
      businessId: string,
      branchId: string,
      normalizedTextHash: string,
      since: Date,
    ): Promise<number> {
      return [...items.values()].filter(
        (i) =>
          i.businessId === businessId &&
          i.branchId === branchId &&
          i.normalizedTextHash === normalizedTextHash &&
          !i.isDeleted &&
          i.createdAt >= since,
      ).length;
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
        hasOpenFraudSignal?: boolean;
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
      if (filters.hasOpenFraudSignal) all = all.filter((i) => openFraudSignalFeedbackIds.has(i.id));

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
    expect(second.duplicateTextCount).toBe(0);
  });

  // Continuing Development S5-C (spec S5.6) -- device-gated near-duplicate
  // scoring. The gate is the substance: text similarity alone was measured
  // unusable at this comment length (see fraud/near-duplicate.ts).

  const DEVICE_A = 'device-hash-aaa';
  const DEVICE_B = 'device-hash-bbb';
  const TEMPLATE = 'Great service at Camden, absolutely loved the burger, will be back!';
  const REFILLED = 'Great service at Oxford, absolutely loved the burger, will be back!';

  it('submit counts a refilled template from the same device as a near-duplicate', async () => {
    const first = await service.submit(QR_CODE, { rating: 5, comment: TEMPLATE }, { deviceHash: DEVICE_A });
    const second = await service.submit(QR_CODE, { rating: 5, comment: REFILLED }, { deviceHash: DEVICE_A });

    expect(first.nearDuplicateCount).toBe(0);
    expect(second.nearDuplicateCount).toBe(1);
    // Not an EXACT duplicate -- the text differs -- so S5-A's counter stays
    // at zero. The two detectors measure different things on the same row.
    expect(second.duplicateTextCount).toBe(0);
  });

  it('submit never scores a near-duplicate across different devices', async () => {
    // The whole point of the gate. Two strangers writing near-identical
    // praise is the false-positive class that made text-only scoring
    // unusable, and it must produce nothing at all.
    await service.submit(QR_CODE, { rating: 5, comment: TEMPLATE }, { deviceHash: DEVICE_A });
    const other = await service.submit(QR_CODE, { rating: 5, comment: REFILLED }, { deviceHash: DEVICE_B });

    expect(other.nearDuplicateCount).toBe(0);
  });

  it('submit scores nothing when the client sent no device signal', async () => {
    await service.submit(QR_CODE, { rating: 5, comment: TEMPLATE });
    const second = await service.submit(QR_CODE, { rating: 5, comment: REFILLED });

    expect(second.deviceHash).toBeNull();
    expect(second.nearDuplicateCount).toBe(0);
  });

  it('submit accumulates the near-duplicate count as a device repeats itself', async () => {
    await service.submit(QR_CODE, { rating: 5, comment: TEMPLATE }, { deviceHash: DEVICE_A });
    await service.submit(QR_CODE, { rating: 5, comment: REFILLED }, { deviceHash: DEVICE_A });
    const third = await service.submit(
      QR_CODE,
      { rating: 5, comment: 'Great service at Bristol, absolutely loved the burger, will be back!' },
      { deviceHash: DEVICE_A },
    );

    // A rising count is what lets the fraud signal's severity distinguish a
    // coincidence from a campaign.
    expect(third.nearDuplicateCount).toBe(2);
  });

  it('submit keeps the near-duplicate scan scoped to one branch', async () => {
    await service.submit(QR_CODE, { rating: 5, comment: TEMPLATE }, { deviceHash: DEVICE_A });
    const otherBranch = await service.submit(
      { ...QR_CODE, branchId: 'branch-b' },
      { rating: 5, comment: REFILLED },
      { deviceHash: DEVICE_A },
    );

    expect(otherBranch.nearDuplicateCount).toBe(0);
  });

  it('submit stores the device hash it was given, and never a raw signal', async () => {
    const item = await service.submit(
      QR_CODE,
      { rating: 4, comment: TEMPLATE, deviceSignal: 'raw-device-fingerprint' },
      { deviceHash: DEVICE_A },
    );

    // The service is handed an already-salted hash; the raw deviceSignal from
    // the request body must never reach the column (S5.4).
    expect(item.deviceHash).toBe(DEVICE_A);
    expect(item.deviceHash).not.toBe('raw-device-fingerprint');
  });

  it('submit ignores unrelated comments from the same device', async () => {
    await service.submit(QR_CODE, { rating: 5, comment: TEMPLATE }, { deviceHash: DEVICE_A });
    const unrelated = await service.submit(
      QR_CODE,
      { rating: 2, comment: 'Parking was impossible and the queue went out the door.' },
      { deviceHash: DEVICE_A },
    );

    // One device legitimately leaves feedback more than once; only NEAR-
    // IDENTICAL text is the signal.
    expect(unrelated.nearDuplicateCount).toBe(0);
  });

  // Continuing Development S5-A (spec S5.6) -- the distinctiveness floor and
  // frequency counting.

  it('submit never flags two customers who write the same short pleasantry', async () => {
    // "great service!" is 14 normalized characters, under MIN_DISTINCTIVE_LENGTH.
    // Before S5-A this flagged the second honest customer as a duplicate.
    await service.submit(QR_CODE, { rating: 5, comment: 'Great service!' });
    const second = await service.submit(QR_CODE, { rating: 5, comment: 'Great service!' });

    expect(second.isDuplicateText).toBe(false);
    expect(second.duplicateTextCount).toBe(0);
  });

  it('submit stores no hash at all for a comment below the distinctiveness floor', async () => {
    // Gating HASHING rather than only flagging is the point: with no hash on
    // the row, no later consumer can rediscover it and draw the conclusion
    // this block exists to prevent.
    const item = await service.submit(QR_CODE, { rating: 5, comment: 'Lovely, thanks' });

    expect(item.normalizedTextHash).toBeNull();
  });

  it('submit counts how many earlier submissions carried the same text, not just whether any did', async () => {
    const comment = 'The service here was extremely slow today.';
    const first = await service.submit(QR_CODE, { rating: 2, comment });
    const second = await service.submit(QR_CODE, { rating: 2, comment });
    const third = await service.submit(QR_CODE, { rating: 2, comment });

    // One repeat is unremarkable; a rising count is what distinguishes a
    // template from a coincidence, and is what S5-B will route on.
    expect(first.duplicateTextCount).toBe(0);
    expect(second.duplicateTextCount).toBe(1);
    expect(third.duplicateTextCount).toBe(2);
    expect(third.isDuplicateText).toBe(true);
  });

  it('submit keeps the duplicate count scoped to one branch', async () => {
    const comment = 'The service here was extremely slow today.';
    await service.submit(QR_CODE, { rating: 2, comment });
    await service.submit(QR_CODE, { rating: 2, comment });
    const otherBranch = await service.submit({ ...QR_CODE, branchId: 'branch-b' }, { rating: 2, comment });

    // Same text at a different branch is at least as plausibly a real
    // chain-wide issue as abuse -- see FeedbackRepository's own comment.
    expect(otherBranch.duplicateTextCount).toBe(0);
    expect(otherBranch.isDuplicateText).toBe(false);
  });

  it('submit keeps isDuplicateText and duplicateTextCount consistent with each other', async () => {
    const comment = 'Placed an order and waited over an hour for it.';
    const first = await service.submit(QR_CODE, { rating: 1, comment });
    const second = await service.submit(QR_CODE, { rating: 1, comment });

    // isDuplicateText is exactly duplicateTextCount > 0 -- the two columns
    // must never disagree, since the inbox filters on one and S5-B will
    // decide on the other.
    expect(first.isDuplicateText).toBe(first.duplicateTextCount > 0);
    expect(second.isDuplicateText).toBe(second.duplicateTextCount > 0);
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

  it('listWithFilters suspected_fraud returns only rows carrying an open fraud signal', async () => {
    // Continuing Development S5-B. Both rows are ordinary feedback; only one
    // has been flagged. A saved view that returned both would be useless,
    // and one that returned neither would hide the queue entirely -- the
    // failure modes on either side of this are what the test pins down.
    const flagged = await service.submit(QR_CODE, { rating: 5, comment: 'Absolutely wonderful, best in town.' });
    await service.submit(QR_CODE, { rating: 4, comment: 'Pleasant enough, would come again sometime.' });
    repos.feedback.openFraudSignalFeedbackIds.add(flagged.id);

    const suspected = await service.listWithFilters(BUSINESS_A, {
      savedView: 'suspected_fraud',
      sortBy: 'createdAt',
      sortDirection: 'desc',
      limit: 25,
      offset: 0,
    });

    expect(suspected.items).toHaveLength(1);
    expect(suspected.items[0]!.id).toBe(flagged.id);
  });

  it('listWithFilters suspected_fraud is orthogonal to feedback triage state', async () => {
    // A flagged row stays in the view after staff mark the FEEDBACK
    // reviewed: reviewing a customer's comment is not the same act as
    // clearing the suspicion, which happens on the fraud signal itself
    // (POST /fraud-signals/:id/review|dismiss).
    const flagged = await service.submit(QR_CODE, { rating: 5, comment: 'Absolutely wonderful, best in town.' });
    repos.feedback.openFraudSignalFeedbackIds.add(flagged.id);
    await service.markReviewed(flagged.id, BUSINESS_A, ACTOR);

    const suspected = await service.listWithFilters(BUSINESS_A, {
      savedView: 'suspected_fraud',
      sortBy: 'createdAt',
      sortDirection: 'desc',
      limit: 25,
      offset: 0,
    });

    expect(suspected.items).toHaveLength(1);
    expect(suspected.items[0]!.status).toBe('reviewed');
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
