import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client';
import { AppError } from '../lib/errors';
import { ConversationService } from './conversation.service';

const mocks = vi.hoisted(() => ({
  enrollment: vi.fn(),
  conversation: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({
    loyaltyAccounts: { findByCustomerAndBusiness: mocks.enrollment },
    conversations: {
      findByCustomerAndBusiness: mocks.conversation,
      create: mocks.create,
    },
  })),
}));

function service() {
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
  const db = { transaction } as unknown as Database;
  return { conversationService: new ConversationService(db), transaction };
}

describe('DEV-67 staff conversation enrollment boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.enrollment.mockResolvedValue({ id: 'membership-a', businessId: 'business-a', customerId: 'customer-a' });
    mocks.conversation.mockResolvedValue(undefined);
    mocks.create.mockImplementation(async (input) => ({ id: 'conversation-a', ...input }));
  });

  it('rejects a customer who is not enrolled at the selected business before any thread access', async () => {
    mocks.enrollment.mockResolvedValueOnce(undefined);
    const { conversationService, transaction } = service();
    await expect(conversationService.getOrCreateForCustomer('business-b', 'customer-a', 'staff-b'))
      .rejects.toMatchObject({
        status: 404,
        code: 'CUSTOMER_NOT_ENROLLED',
      } satisfies Partial<AppError>);

    expect(transaction).toHaveBeenCalledOnce();
    expect(mocks.enrollment).toHaveBeenCalledWith('customer-a', 'business-b');
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates the thread only after verifying the exact business/customer enrollment pair', async () => {
    const { conversationService } = service();
    const result = await conversationService.getOrCreateForCustomer('business-a', 'customer-a', 'staff-a');
    expect(mocks.enrollment).toHaveBeenCalledOnce();
    expect(mocks.enrollment).toHaveBeenCalledWith('customer-a', 'business-a');
    expect(mocks.conversation).toHaveBeenCalledWith('customer-a', 'business-a');
    expect(mocks.create).toHaveBeenCalledWith({
      businessId: 'business-a', customerId: 'customer-a', createdBy: 'staff-a',
    });
    expect(result).toMatchObject({
      id: 'conversation-a', businessId: 'business-a', customerId: 'customer-a',
    });
    expect(mocks.enrollment.mock.invocationCallOrder[0]).toBeLessThan(mocks.conversation.mock.invocationCallOrder[0]!);
    expect(mocks.conversation.mock.invocationCallOrder[0]).toBeLessThan(mocks.create.mock.invocationCallOrder[0]!);
  });

  it('preserves existing conversation reuse for customers with active enrollment', async () => {
    const existing = { id: 'existing-a', businessId: 'business-a', customerId: 'customer-a' };
    mocks.conversation.mockResolvedValueOnce(existing);
    const { conversationService } = service();
    const result = await conversationService.getOrCreateForCustomer('business-a', 'customer-a', 'staff-a');
    expect(result).toEqual(existing);
    expect(mocks.enrollment).toHaveBeenCalledWith('customer-a', 'business-a');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not reuse even an existing conversation after its business enrollment is removed', async () => {
    mocks.enrollment.mockResolvedValueOnce(undefined);
    mocks.conversation.mockResolvedValueOnce({ id: 'old-conversation' });
    const { conversationService } = service();
    await expect(conversationService.getOrCreateForCustomer('business-a', 'customer-a', 'staff-a'))
      .rejects.toMatchObject({ status: 404, code: 'CUSTOMER_NOT_ENROLLED' });
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('propagates database membership-read failures without creating a thread', async () => {
    mocks.enrollment.mockRejectedValueOnce(new Error('membership DB unavailable'));
    const { conversationService } = service();
    await expect(conversationService.getOrCreateForCustomer('business-a', 'customer-a', 'staff-a'))
      .rejects.toThrow('membership DB unavailable');
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
