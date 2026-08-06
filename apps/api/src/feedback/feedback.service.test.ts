import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackService } from './feedback.service';
import type { Feedback, NewFeedback } from '../repositories/feedback.repository';
import type { QrCode } from '../repositories/qr-code.repository';

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
  let repos: { feedback: ReturnType<typeof createFakeFeedbackRepo> };
  let service: FeedbackService;

  beforeEach(() => {
    repos = { feedback: createFakeFeedbackRepo() };
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
});
