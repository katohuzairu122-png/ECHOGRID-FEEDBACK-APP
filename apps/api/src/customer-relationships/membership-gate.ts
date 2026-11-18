import { AppError } from '../lib/errors';
import type { BusinessCustomerMembership, LoyaltyAccount, Repositories } from '../repositories';

/**
 * Split 01: the single rule for "may this customer earn or spend loyalty value
 * at this business right now?". Check-in, reward redemption and voucher
 * issuance all ask it, so a membership that ended, was suspended or never
 * existed is refused the same way everywhere, and the refusal tells the client
 * what the customer can do about it:
 *
 *   MEMBERSHIP_REQUIRED          409  no membership, or the customer left: joining (again) fixes it
 *   MEMBERSHIP_SUSPENDED         403  the membership or the loyalty account is suspended: contact the business
 *   MEMBERSHIP_UNAVAILABLE       409  pending, business_exited or closed: not something the customer can fix
 *   LOYALTY_ACCOUNT_NOT_READY    409  active membership but no loyalty account yet
 *   MEMBERSHIP_MAPPING_CONFLICT  409  the account points at a different membership
 *
 * Fail-closed: any membership status other than `active` that is not named
 * above is treated as unavailable, so a status added later cannot silently
 * start earning or spending.
 */
export type MembershipGateAction = 'checkin' | 'redeem';

export interface MembershipGateRefusal {
  readonly status: 403 | 409;
  readonly code:
    | 'MEMBERSHIP_REQUIRED'
    | 'MEMBERSHIP_SUSPENDED'
    | 'MEMBERSHIP_UNAVAILABLE'
    | 'LOYALTY_ACCOUNT_NOT_READY'
    | 'MEMBERSHIP_MAPPING_CONFLICT';
  readonly message: string;
}

export type MembershipGateDecision<M, A> =
  | { readonly ok: true; readonly membership: M; readonly account: A }
  | { readonly ok: false; readonly refusal: MembershipGateRefusal };

const JOIN_FIRST_MESSAGE: Record<MembershipGateAction, string> = {
  checkin: 'Join this loyalty program before checking in.',
  redeem: 'Join this loyalty program before redeeming rewards.',
};

const SUSPENDED: MembershipGateRefusal = {
  status: 403,
  code: 'MEMBERSHIP_SUSPENDED',
  message: 'Your membership with this business is suspended. Please contact the business.',
};
const UNAVAILABLE: MembershipGateRefusal = {
  status: 409,
  code: 'MEMBERSHIP_UNAVAILABLE',
  message: 'Your membership with this business is not active. Please contact the business.',
};
const ACCOUNT_NOT_READY: MembershipGateRefusal = {
  status: 409,
  code: 'LOYALTY_ACCOUNT_NOT_READY',
  message: 'Your loyalty account is not ready for this membership.',
};
const MAPPING_CONFLICT: MembershipGateRefusal = {
  status: 409,
  code: 'MEMBERSHIP_MAPPING_CONFLICT',
  message: 'Loyalty membership mapping is inconsistent.',
};

/**
 * Pure decision: no I/O, so every branch is unit-testable. Returns the
 * membership and account unchanged when the customer may proceed.
 */
export function evaluateMembershipGate<
  M extends Pick<BusinessCustomerMembership, 'id' | 'status'>,
  A extends Pick<LoyaltyAccount, 'membershipId' | 'status'>,
>(
  membership: M | undefined,
  account: A | undefined,
  action: MembershipGateAction,
): MembershipGateDecision<M, A> {
  if (!membership || membership.status === 'left') {
    return {
      ok: false,
      refusal: { status: 409, code: 'MEMBERSHIP_REQUIRED', message: JOIN_FIRST_MESSAGE[action] },
    };
  }
  if (membership.status === 'suspended') return { ok: false, refusal: SUSPENDED };
  if (membership.status !== 'active') return { ok: false, refusal: UNAVAILABLE };

  if (!account) return { ok: false, refusal: ACCOUNT_NOT_READY };
  if (account.membershipId && account.membershipId !== membership.id) {
    return { ok: false, refusal: MAPPING_CONFLICT };
  }
  if (account.status !== 'active') return { ok: false, refusal: SUSPENDED };

  return { ok: true, membership, account };
}

export interface MembershipGateInput {
  customerId: string;
  businessId: string;
  action: MembershipGateAction;
  /** An account the caller already loaded, so it is not read twice. */
  account?: LoyaltyAccount | undefined;
  /**
   * Read the membership with a row-level SHARE lock (held until the caller's
   * transaction ends) so a concurrent leave or consent withdrawal is strictly
   * ordered against the spend or earn that follows. Only valid inside a
   * transaction; leave it off for a read-only preflight.
   */
  lockMembership?: boolean;
}

/**
 * Loads the membership (and the account, unless the caller supplied it),
 * applies `evaluateMembershipGate` and throws the refusal as an `AppError`.
 */
export async function assertMembershipGate(
  repos: Pick<Repositories, 'customerMemberships' | 'loyaltyAccounts'>,
  input: MembershipGateInput,
): Promise<{ membership: BusinessCustomerMembership; account: LoyaltyAccount }> {
  const membership = input.lockMembership
    ? await repos.customerMemberships.findByCustomerAndBusinessForShare(
        input.customerId,
        input.businessId,
      )
    : await repos.customerMemberships.findByCustomerAndBusiness(input.customerId, input.businessId);
  const account =
    input.account ??
    (await repos.loyaltyAccounts.findByCustomerAndBusiness(input.customerId, input.businessId));

  const decision = evaluateMembershipGate(membership, account, input.action);
  if (!decision.ok) {
    throw new AppError(decision.refusal.message, decision.refusal.status, decision.refusal.code);
  }
  return { membership: decision.membership, account: decision.account };
}
