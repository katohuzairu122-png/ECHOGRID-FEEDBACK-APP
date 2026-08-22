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
  token: 'tok123',
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
});
