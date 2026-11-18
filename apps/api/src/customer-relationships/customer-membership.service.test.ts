import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerMembershipService } from './customer-membership.service';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  transaction: vi.fn(),
  findBusiness: vi.fn(),
  findMembership: vi.fn(),
  listMemberships: vi.fn(),
  createMembership: vi.fn(),
  reactivate: vi.fn(),
  markLeft: vi.fn(),
  findActiveConsent: vi.fn(),
  createConsent: vi.fn(),
  revokeActiveForPurpose: vi.fn(),
  findAccount: vi.fn(),
  createAccount: vi.fn(),
  attachMembership: vi.fn(),
}));

vi.mock('../repositories', () => ({
  createRepositories: () => ({
    businesses: { findById: mocks.findBusiness },
    customerMemberships: {
      findByCustomerAndBusiness: mocks.findMembership,
      listForCustomer: mocks.listMemberships,
      create: mocks.createMembership,
      reactivate: mocks.reactivate,
      markLeft: mocks.markLeft,
    },
    consentGrants: {
      findActive: mocks.findActiveConsent,
      create: mocks.createConsent,
      revokeActiveForPurpose: mocks.revokeActiveForPurpose,
    },
    loyaltyAccounts: {
      findByCustomerAndBusiness: mocks.findAccount,
      create: mocks.createAccount,
      attachMembership: mocks.attachMembership,
    },
  }),
}));
vi.mock('../lib/customer-limits', () => ({ assertCustomerNotLimited: async () => undefined }));
vi.mock('../lib/customer-verification', () => ({ assertVerifiedPhone: async () => undefined }));

const CUSTOMER = 'customer-1';
const BUSINESS = 'business-1';
const membership = (status: string) => ({
  id: 'membership-1',
  customerId: CUSTOMER,
  businessId: BUSINESS,
  status,
});
const service = () => new CustomerMembershipService({ transaction: mocks.transaction } as never);
const firstCall = (m: { mock: { invocationCallOrder: number[] } }) =>
  Math.min(...m.mock.invocationCallOrder);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ execute: mocks.execute }),
  );
});

describe('CustomerMembershipService.leave', () => {
  it('ends an active membership and withdraws the join consent, after taking the relationship lock', async () => {
    mocks.findMembership.mockResolvedValueOnce(membership('active'));
    mocks.markLeft.mockResolvedValueOnce(membership('left'));

    await expect(service().leave(CUSTOMER, BUSINESS)).resolves.toEqual(membership('left'));

    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(firstCall(mocks.execute)).toBeLessThan(firstCall(mocks.findMembership));
    expect(mocks.findMembership).toHaveBeenCalledWith(CUSTOMER, BUSINESS);
    expect(mocks.markLeft).toHaveBeenCalledExactlyOnceWith('membership-1');
    expect(mocks.revokeActiveForPurpose).toHaveBeenCalledExactlyOnceWith(
      CUSTOMER,
      BUSINESS,
      'join_loyalty',
    );
  });

  it('does not touch the loyalty account or its points', async () => {
    mocks.findMembership.mockResolvedValueOnce(membership('active'));
    mocks.markLeft.mockResolvedValueOnce(membership('left'));

    await service().leave(CUSTOMER, BUSINESS);

    expect(mocks.findAccount).not.toHaveBeenCalled();
    expect(mocks.createAccount).not.toHaveBeenCalled();
    expect(mocks.attachMembership).not.toHaveBeenCalled();
  });

  it('is idempotent: a membership that was already left is returned unchanged, with no writes', async () => {
    const already = membership('left');
    mocks.findMembership.mockResolvedValueOnce(already);

    await expect(service().leave(CUSTOMER, BUSINESS)).resolves.toBe(already);

    expect(mocks.markLeft).not.toHaveBeenCalled();
    expect(mocks.revokeActiveForPurpose).not.toHaveBeenCalled();
  });

  it('answers 404 when the customer has no membership with that business', async () => {
    mocks.findMembership.mockResolvedValueOnce(undefined);

    await expect(service().leave(CUSTOMER, BUSINESS)).rejects.toMatchObject({
      status: 404,
      code: 'CUSTOMER_MEMBERSHIP_NOT_FOUND',
    });
    expect(mocks.markLeft).not.toHaveBeenCalled();
  });

  it.each([['suspended'], ['pending'], ['business_exited'], ['closed']])(
    'refuses to let the customer leave a %s membership: that is for the business or the platform to resolve',
    async (status) => {
      mocks.findMembership.mockResolvedValueOnce(membership(status));

      await expect(service().leave(CUSTOMER, BUSINESS)).rejects.toMatchObject({
        status: 409,
        code: 'MEMBERSHIP_NOT_LEAVABLE',
      });
      expect(mocks.markLeft).not.toHaveBeenCalled();
      expect(mocks.revokeActiveForPurpose).not.toHaveBeenCalled();
    },
  );

  it('refuses, and withdraws no consent, when the membership stopped being active between its read and its update', async () => {
    mocks.findMembership.mockResolvedValueOnce(membership('active'));
    mocks.markLeft.mockResolvedValueOnce(undefined);

    await expect(service().leave(CUSTOMER, BUSINESS)).rejects.toMatchObject({
      status: 409,
      code: 'MEMBERSHIP_NOT_LEAVABLE',
    });
    expect(mocks.revokeActiveForPurpose).not.toHaveBeenCalled();
  });
});

describe('CustomerMembershipService.join: consent idempotency', () => {
  const input = {
    customerId: CUSTOMER,
    businessId: BUSINESS,
    onboardingSource: 'business_qr',
    onboardingReference: 'qr-1',
    consentVersion: 'v1',
    idempotencyKey: 'replayed-key-1',
  } as const;
  const account = {
    id: 'account-1',
    customerId: CUSTOMER,
    businessId: BUSINESS,
    membershipId: 'membership-1',
  };

  beforeEach(() => {
    mocks.findBusiness.mockResolvedValue({ id: BUSINESS, status: 'active' });
    mocks.listMemberships.mockResolvedValue([]);
    mocks.findActiveConsent.mockResolvedValue(undefined);
    mocks.reactivate.mockResolvedValue(membership('active'));
    mocks.findAccount.mockResolvedValue(account);
  });

  it('refuses to bring a left membership back on the strength of a consent the customer already withdrew', async () => {
    mocks.findMembership.mockResolvedValueOnce(membership('left'));
    // The idempotency key resolves to the grant it first created, which was revoked when the customer left.
    mocks.createConsent.mockResolvedValueOnce({ id: 'grant-1', status: 'revoked' });

    await expect(service().join(input)).rejects.toMatchObject({
      status: 409,
      code: 'CONSENT_IDEMPOTENCY_CONFLICT',
    });
    expect(mocks.findAccount).not.toHaveBeenCalled();
  });

  it('joins normally when the consent it records is a live one', async () => {
    mocks.findMembership.mockResolvedValueOnce(membership('left'));
    mocks.createConsent.mockResolvedValueOnce({ id: 'grant-2', status: 'active' });

    await expect(service().join(input)).resolves.toEqual({
      membership: membership('active'),
      loyaltyAccount: account,
    });
    expect(mocks.reactivate).toHaveBeenCalledOnce();
  });

  it('records no new consent for a member who already has a live one', async () => {
    mocks.findMembership.mockResolvedValueOnce(membership('active'));
    mocks.findActiveConsent.mockResolvedValueOnce({ id: 'grant-1', status: 'active' });

    await expect(service().join(input)).resolves.toMatchObject({ loyaltyAccount: account });
    expect(mocks.createConsent).not.toHaveBeenCalled();
  });
});
