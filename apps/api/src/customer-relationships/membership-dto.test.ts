import { describe, expect, it } from 'vitest';
import type { BusinessCustomerMembership, LoyaltyAccount } from '../repositories';
import {
  toCustomerLoyaltyAccountDto,
  toCustomerMembershipDto,
  toJoinMembershipResultDto,
} from './membership-dto';

/** A membership row as the database returns it: the DTO fields plus internal columns. */
const membershipRow = (
  overrides: Partial<BusinessCustomerMembership> = {},
): BusinessCustomerMembership => ({
  id: '5c1c7a77-0d0a-4a54-8f4e-1d0f5f6a7b88',
  customerId: '9a7d1e3c-5b2f-4c68-8a10-2e4d6f8a0b12',
  businessId: '0b3f7f0e-6a55-4d1a-9d52-3f9e0a1f2c11',
  status: 'active',
  joinedAt: new Date('2026-11-01T10:00:00.000Z'),
  leftAt: null,
  suspendedAt: null,
  businessExitedAt: null,
  closedAt: null,
  onboardingSource: 'business_qr',
  onboardingReference: 'qr-1',
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  createdBy: null,
  updatedAt: new Date('2026-11-01T10:00:00.000Z'),
  updatedBy: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
  ...overrides,
});

/** An account row as the database returns it, including columns a customer response must not carry. */
const accountRow = (overrides: Partial<LoyaltyAccount> = {}): LoyaltyAccount => ({
  id: '7e2a4c10-3d9b-4f5e-a1c6-8b0d2f4a6c13',
  customerId: '9a7d1e3c-5b2f-4c68-8a10-2e4d6f8a0b12',
  businessId: '0b3f7f0e-6a55-4d1a-9d52-3f9e0a1f2c11',
  membershipId: '5c1c7a77-0d0a-4a54-8f4e-1d0f5f6a7b88',
  points: 120,
  tierId: null,
  referredByCustomerId: '2b4d6f80-1a3c-4e5f-9a7b-0c1d2e3f4a5b',
  visitCount: 4,
  lastVisitAt: new Date('2026-11-17T18:00:00.000Z'),
  status: 'active',
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  createdBy: null,
  updatedAt: new Date('2026-11-17T18:00:00.000Z'),
  updatedBy: null,
  isDeleted: false,
  deletedAt: null,
  deletedBy: null,
  ...overrides,
});

describe('toCustomerMembershipDto', () => {
  it('returns exactly the declared fields, with dates as ISO strings', () => {
    expect(toCustomerMembershipDto(membershipRow())).toEqual({
      id: '5c1c7a77-0d0a-4a54-8f4e-1d0f5f6a7b88',
      customerId: '9a7d1e3c-5b2f-4c68-8a10-2e4d6f8a0b12',
      businessId: '0b3f7f0e-6a55-4d1a-9d52-3f9e0a1f2c11',
      status: 'active',
      joinedAt: '2026-11-01T10:00:00.000Z',
      leftAt: null,
      onboardingSource: 'business_qr',
      onboardingReference: 'qr-1',
    });
  });

  it('carries the leave time once the customer has left', () => {
    const dto = toCustomerMembershipDto(
      membershipRow({ status: 'left', leftAt: new Date('2026-11-18T09:30:00.000Z') }),
    );
    expect(dto.status).toBe('left');
    expect(dto.leftAt).toBe('2026-11-18T09:30:00.000Z');
  });

  it('keeps legacy memberships (no onboarding source or reference) representable', () => {
    const dto = toCustomerMembershipDto(
      membershipRow({ onboardingSource: null, onboardingReference: null }),
    );
    expect(dto.onboardingSource).toBeNull();
    expect(dto.onboardingReference).toBeNull();
  });

  it('leaves out audit columns, soft-delete flags and the suspension/exit timestamps', () => {
    const dto = toCustomerMembershipDto(
      membershipRow({
        suspendedAt: new Date(),
        businessExitedAt: new Date(),
        closedAt: new Date(),
      }),
    );
    expect(Object.keys(dto).sort()).toEqual([
      'businessId',
      'customerId',
      'id',
      'joinedAt',
      'leftAt',
      'onboardingReference',
      'onboardingSource',
      'status',
    ]);
  });
});

describe('toCustomerLoyaltyAccountDto', () => {
  it('returns exactly the declared fields, with the visit time as an ISO string', () => {
    expect(toCustomerLoyaltyAccountDto(accountRow())).toEqual({
      id: '7e2a4c10-3d9b-4f5e-a1c6-8b0d2f4a6c13',
      customerId: '9a7d1e3c-5b2f-4c68-8a10-2e4d6f8a0b12',
      businessId: '0b3f7f0e-6a55-4d1a-9d52-3f9e0a1f2c11',
      points: 120,
      tierId: null,
      visitCount: 4,
      lastVisitAt: '2026-11-17T18:00:00.000Z',
      status: 'active',
    });
  });

  it('does not carry the membership link, the referrer or audit/soft-delete columns', () => {
    const dto = toCustomerLoyaltyAccountDto(accountRow());
    for (const internal of [
      'membershipId',
      'referredByCustomerId',
      'createdBy',
      'updatedBy',
      'isDeleted',
    ]) {
      expect(dto).not.toHaveProperty(internal);
    }
  });

  it('reports a first-time account (never visited) with a null visit time', () => {
    expect(
      toCustomerLoyaltyAccountDto(accountRow({ lastVisitAt: null, visitCount: 0 })).lastVisitAt,
    ).toBeNull();
  });

  it('reports a suspended account as suspended', () => {
    expect(toCustomerLoyaltyAccountDto(accountRow({ status: 'suspended' })).status).toBe(
      'suspended',
    );
  });

  it('is fail-closed: an unrecognised status reads as suspended, never active', () => {
    expect(toCustomerLoyaltyAccountDto(accountRow({ status: 'archived' })).status).toBe(
      'suspended',
    );
  });
});

describe('toJoinMembershipResultDto', () => {
  it('pairs the membership DTO with the account DTO', () => {
    const result = toJoinMembershipResultDto({
      membership: membershipRow(),
      loyaltyAccount: accountRow(),
    });
    expect(result.membership).toEqual(toCustomerMembershipDto(membershipRow()));
    expect(result.loyaltyAccount).toEqual(toCustomerLoyaltyAccountDto(accountRow()));
    expect(Object.keys(result).sort()).toEqual(['loyaltyAccount', 'membership']);
  });
});
