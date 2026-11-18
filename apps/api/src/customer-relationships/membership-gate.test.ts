import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors';
import type { BusinessCustomerMembership } from '../repositories';
import {
  assertMembershipGate,
  evaluateMembershipGate,
  type MembershipGateAction,
} from './membership-gate';

type Status = BusinessCustomerMembership['status'];

const membership = (status: Status, id = 'membership-1') => ({ id, status });
const account = (overrides: Partial<{ membershipId: string | null; status: string }> = {}) => ({
  membershipId: 'membership-1' as string | null,
  status: 'active',
  ...overrides,
});

const refusalOf = (
  m: ReturnType<typeof membership> | undefined,
  a: ReturnType<typeof account> | undefined,
  action: MembershipGateAction = 'redeem',
) => {
  const decision = evaluateMembershipGate(m, a, action);
  if (decision.ok) throw new Error('expected a refusal');
  return decision.refusal;
};

describe('evaluateMembershipGate', () => {
  it('lets an active membership with a consistent, active account through, unchanged', () => {
    const m = membership('active');
    const a = account();
    const decision = evaluateMembershipGate(m, a, 'redeem');
    expect(decision).toEqual({ ok: true, membership: m, account: a });
    expect(decision.ok && decision.membership).toBe(m);
  });

  it('accepts an account that was never mapped to a membership (legacy rows are backfilled, not rejected)', () => {
    expect(
      evaluateMembershipGate(membership('active'), account({ membershipId: null }), 'checkin').ok,
    ).toBe(true);
  });

  it.each<[string, ReturnType<typeof membership> | undefined]>([
    ['no membership', undefined],
    ['a membership the customer left', membership('left')],
  ])('asks the customer to join again when there is %s', (_label, m) => {
    expect(refusalOf(m, account())).toMatchObject({ status: 409, code: 'MEMBERSHIP_REQUIRED' });
  });

  it('words the join prompt for what the customer was trying to do', () => {
    expect(refusalOf(undefined, undefined, 'checkin').message).toBe(
      'Join this loyalty program before checking in.',
    );
    expect(refusalOf(undefined, undefined, 'redeem').message).toBe(
      'Join this loyalty program before redeeming rewards.',
    );
  });

  it('refuses a suspended membership with a 403 the customer cannot fix by joining', () => {
    expect(refusalOf(membership('suspended'), account())).toMatchObject({
      status: 403,
      code: 'MEMBERSHIP_SUSPENDED',
    });
  });

  it.each<Status>(['pending', 'business_exited', 'closed'])(
    'refuses a %s membership as unavailable',
    (status) => {
      expect(refusalOf(membership(status), account())).toMatchObject({
        status: 409,
        code: 'MEMBERSHIP_UNAVAILABLE',
      });
    },
  );

  it('is fail-closed: a membership status that is not recognised is unavailable, never active', () => {
    // `as string as Status`: a status the type does not know cannot be written as a bare literal cast.
    expect(refusalOf(membership('archived' as string as Status), account())).toMatchObject({
      code: 'MEMBERSHIP_UNAVAILABLE',
    });
  });

  it('refuses an active membership that has no loyalty account yet', () => {
    expect(refusalOf(membership('active'), undefined)).toMatchObject({
      status: 409,
      code: 'LOYALTY_ACCOUNT_NOT_READY',
    });
  });

  it('refuses an account that belongs to a different membership', () => {
    expect(
      refusalOf(membership('active'), account({ membershipId: 'another-membership' })),
    ).toMatchObject({
      status: 409,
      code: 'MEMBERSHIP_MAPPING_CONFLICT',
    });
  });

  it('refuses a suspended loyalty account even though the membership is active', () => {
    expect(refusalOf(membership('active'), account({ status: 'suspended' }))).toMatchObject({
      status: 403,
      code: 'MEMBERSHIP_SUSPENDED',
    });
  });

  it('judges the membership before the account', () => {
    expect(refusalOf(membership('left'), account({ status: 'suspended' })).code).toBe(
      'MEMBERSHIP_REQUIRED',
    );
    expect(refusalOf(membership('suspended'), undefined).code).toBe('MEMBERSHIP_SUSPENDED');
    expect(
      refusalOf(membership('active'), account({ membershipId: 'other', status: 'suspended' })).code,
    ).toBe('MEMBERSHIP_MAPPING_CONFLICT');
  });
});

describe('assertMembershipGate', () => {
  const build = (
    m: ReturnType<typeof membership> | undefined,
    a: ReturnType<typeof account> | undefined,
  ) => {
    const customerMemberships = {
      findByCustomerAndBusiness: vi.fn(async () => m),
      findByCustomerAndBusinessForShare: vi.fn(async () => m),
    };
    const loyaltyAccounts = { findByCustomerAndBusiness: vi.fn(async () => a) };
    return {
      customerMemberships,
      loyaltyAccounts,
      repos: { customerMemberships, loyaltyAccounts } as unknown as Parameters<
        typeof assertMembershipGate
      >[0],
    };
  };
  const input = { customerId: 'customer-1', businessId: 'business-1', action: 'redeem' } as const;

  it('reads the membership without a lock by default (the read-only preflight)', async () => {
    const { repos, customerMemberships } = build(membership('active'), account());
    await assertMembershipGate(repos, input);
    expect(customerMemberships.findByCustomerAndBusiness).toHaveBeenCalledWith(
      'customer-1',
      'business-1',
    );
    expect(customerMemberships.findByCustomerAndBusinessForShare).not.toHaveBeenCalled();
  });

  it('share-locks the membership row when asked, for the in-transaction caller', async () => {
    const { repos, customerMemberships } = build(membership('active'), account());
    await assertMembershipGate(repos, { ...input, lockMembership: true });
    expect(customerMemberships.findByCustomerAndBusinessForShare).toHaveBeenCalledWith(
      'customer-1',
      'business-1',
    );
    expect(customerMemberships.findByCustomerAndBusiness).not.toHaveBeenCalled();
  });

  it('does not read the account again when the caller already has it', async () => {
    const { repos, loyaltyAccounts } = build(membership('active'), undefined);
    const supplied = account();
    const result = await assertMembershipGate(repos, { ...input, account: supplied as never });
    expect(loyaltyAccounts.findByCustomerAndBusiness).not.toHaveBeenCalled();
    expect(result.account).toBe(supplied);
  });

  it('loads the account itself when none is supplied', async () => {
    const { repos, loyaltyAccounts } = build(membership('active'), account());
    await assertMembershipGate(repos, input);
    expect(loyaltyAccounts.findByCustomerAndBusiness).toHaveBeenCalledWith(
      'customer-1',
      'business-1',
    );
  });

  it.each([
    ['left', membership('left'), 409, 'MEMBERSHIP_REQUIRED'],
    ['suspended', membership('suspended'), 403, 'MEMBERSHIP_SUSPENDED'],
    ['closed', membership('closed'), 409, 'MEMBERSHIP_UNAVAILABLE'],
  ] as const)(
    'throws the refusal as an AppError for a %s membership',
    async (_label, m, status, code) => {
      const { repos } = build(m, account());
      const error = await assertMembershipGate(repos, input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status, code });
    },
  );
});
