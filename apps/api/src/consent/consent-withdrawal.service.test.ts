import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentWithdrawalService } from './consent-withdrawal.service';

const mocks = vi.hoisted(() => ({
  findOwned: vi.fn(),
  revoke: vi.fn(),
  revokeReturning: vi.fn(),
  revokeActiveForPurpose: vi.fn(),
  findMembership: vi.fn(),
  markLeft: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../repositories', () => ({
  createRepositories: () => ({
    consentGrants: {
      findOwned: mocks.findOwned,
      revoke: mocks.revoke,
      revokeReturning: mocks.revokeReturning,
      revokeActiveForPurpose: mocks.revokeActiveForPurpose,
    },
    customerMemberships: {
      findByCustomerAndBusiness: mocks.findMembership,
      markLeft: mocks.markLeft,
    },
  }),
}));

const CUSTOMER = 'customer-1';
const BUSINESS = 'business-1';
const GRANT = 'grant-1';
const joinGrant = {
  id: GRANT,
  customerId: CUSTOMER,
  businessId: BUSINESS,
  purpose: 'join_loyalty',
  status: 'active',
};
const membership = (status: string) => ({
  id: 'membership-1',
  customerId: CUSTOMER,
  businessId: BUSINESS,
  status,
});

const service = () => new ConsentWithdrawalService({ transaction: mocks.transaction } as never);
const calledBefore = (
  first: { mock: { invocationCallOrder: number[] } },
  second: { mock: { invocationCallOrder: number[] } },
) => Math.min(...first.mock.invocationCallOrder) < Math.min(...second.mock.invocationCallOrder);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ execute: mocks.execute }),
  );
});

describe('ConsentWithdrawalService.revoke', () => {
  it('reports false, and touches nothing, when the grant is not the caller’s or does not exist', async () => {
    mocks.findOwned.mockResolvedValueOnce(undefined);

    await expect(service().revoke(GRANT, CUSTOMER)).resolves.toBe(false);

    expect(mocks.findOwned).toHaveBeenCalledWith(GRANT, CUSTOMER);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it.each([['marketing'], ['survey_participation'], ['settlement_access'], ['contact_sharing']])(
    'revokes a %s consent as a plain state change: no lock, no membership change',
    async (purpose) => {
      mocks.findOwned.mockResolvedValueOnce({ ...joinGrant, purpose });
      mocks.revoke.mockResolvedValueOnce(true);

      await expect(service().revoke(GRANT, CUSTOMER)).resolves.toBe(true);

      expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(GRANT, CUSTOMER);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.markLeft).not.toHaveBeenCalled();
    },
  );

  it('passes the plain revoke outcome through, so an expired or already revoked grant is still a 404 for the route', async () => {
    mocks.findOwned.mockResolvedValueOnce({
      ...joinGrant,
      purpose: 'marketing',
      status: 'revoked',
    });
    mocks.revoke.mockResolvedValueOnce(false);

    await expect(service().revoke(GRANT, CUSTOMER)).resolves.toBe(false);
  });

  it('treats a join consent that names no business as a plain revoke (nothing to end)', async () => {
    mocks.findOwned.mockResolvedValueOnce({ ...joinGrant, businessId: null });
    mocks.revoke.mockResolvedValueOnce(true);

    await expect(service().revoke(GRANT, CUSTOMER)).resolves.toBe(true);

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('ends the active membership and withdraws the join consent in one transaction, under the relationship lock', async () => {
    mocks.findOwned.mockResolvedValueOnce(joinGrant);
    mocks.revokeReturning.mockResolvedValueOnce({ ...joinGrant, status: 'revoked' });
    mocks.findMembership.mockResolvedValueOnce(membership('active'));
    mocks.markLeft.mockResolvedValueOnce({ ...membership('left') });

    await expect(service().revoke(GRANT, CUSTOMER)).resolves.toBe(true);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(calledBefore(mocks.execute, mocks.revokeReturning)).toBe(true);
    expect(mocks.revokeReturning).toHaveBeenCalledExactlyOnceWith(GRANT, CUSTOMER);
    expect(mocks.findMembership).toHaveBeenCalledWith(CUSTOMER, BUSINESS);
    expect(mocks.markLeft).toHaveBeenCalledExactlyOnceWith('membership-1');
    expect(mocks.revokeActiveForPurpose).toHaveBeenCalledExactlyOnceWith(
      CUSTOMER,
      BUSINESS,
      'join_loyalty',
    );
  });

  it.each([['left'], ['suspended'], ['closed']])(
    'revokes the consent but leaves a %s membership as it is',
    async (status) => {
      mocks.findOwned.mockResolvedValueOnce(joinGrant);
      mocks.revokeReturning.mockResolvedValueOnce({ ...joinGrant, status: 'revoked' });
      mocks.findMembership.mockResolvedValueOnce(membership(status));

      await expect(service().revoke(GRANT, CUSTOMER)).resolves.toBe(true);

      expect(mocks.markLeft).not.toHaveBeenCalled();
      expect(mocks.revokeActiveForPurpose).not.toHaveBeenCalled();
    },
  );

  it('still succeeds when the customer has no membership row at all', async () => {
    mocks.findOwned.mockResolvedValueOnce(joinGrant);
    mocks.revokeReturning.mockResolvedValueOnce({ ...joinGrant, status: 'revoked' });
    mocks.findMembership.mockResolvedValueOnce(undefined);

    await expect(service().revoke(GRANT, CUSTOMER)).resolves.toBe(true);

    expect(mocks.markLeft).not.toHaveBeenCalled();
  });

  it('reports false and changes no membership when the grant was revoked between the read and the lock', async () => {
    mocks.findOwned.mockResolvedValueOnce(joinGrant);
    mocks.revokeReturning.mockResolvedValueOnce(undefined);

    await expect(service().revoke(GRANT, CUSTOMER)).resolves.toBe(false);

    expect(mocks.findMembership).not.toHaveBeenCalled();
    expect(mocks.markLeft).not.toHaveBeenCalled();
  });

  it('does not report a failure when the membership stopped being active between its read and its update', async () => {
    mocks.findOwned.mockResolvedValueOnce(joinGrant);
    mocks.revokeReturning.mockResolvedValueOnce({ ...joinGrant, status: 'revoked' });
    mocks.findMembership.mockResolvedValueOnce(membership('active'));
    mocks.markLeft.mockResolvedValueOnce(undefined);

    await expect(service().revoke(GRANT, CUSTOMER)).resolves.toBe(true);

    expect(mocks.revokeActiveForPurpose).not.toHaveBeenCalled();
  });

  it('lets a database failure propagate so the route answers 500 and the transaction rolls back', async () => {
    mocks.findOwned.mockResolvedValueOnce(joinGrant);
    mocks.revokeReturning.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service().revoke(GRANT, CUSTOMER)).rejects.toThrow('database unavailable');
  });
});
