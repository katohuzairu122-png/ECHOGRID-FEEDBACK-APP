import { APPROVED_SUBSCRIPTION_CATALOG } from '../billing/subscription-catalog';

/**
 * PC-ECON/2 proposal. Pure calculation only: not a frozen, signed policy,
 * not a Stripe price authority, and never an award or billing mutation.
 * Free and custom-priced Enterprise have no authorized earning rate.
 */
export const PROPOSED_PROGRESSIVE_EARNING_RATES = {
  starter: 3,
  growth: 2,
  business: 1,
} as const;
export const PROPOSED_POLICY_VERSION = 'PC-ECON/2-DRAFT' as const;
export const PROPOSED_MONTHLY_UNIT_CAP = 10;
export const PROPOSED_USD_CENTS_PER_UNIT = 100;
export const PROPOSED_DISCOUNT_PERCENT = 30;

export type ProposedEarningPlan = keyof typeof PROPOSED_PROGRESSIVE_EARNING_RATES;

export interface FulfillmentTierSnapshotCandidate {
  subscriptionId: string;
  planId: string;
  planKey: string;
  stripePriceId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  businessId: string;
  billingInterval: 'month' | 'year';
  activeAtFulfillment: boolean;
  fulfillmentAt: Date;
}

/**
 * The caller-supplied snapshot is UNTRUSTED: an authoritative historical
 * subscription tier-at-fulfillment reader does not exist in this version.
 * Only a future provider-backed immutable snapshot can authorize issuance.
 */
export function inspectProgressiveAwardCandidate(
  snapshot: FulfillmentTierSnapshotCandidate,
  awardedUnitsInUtcMonth: number,
): {
  policyVersion: typeof PROPOSED_POLICY_VERSION;
  candidateUnits: number;
  awardableUnits: number;
  state: 'candidate' | 'not_eligible' | 'cap_exceeded';
  historicalTierVerified: false;
  issuanceAuthorized: false;
} {
  if (!Number.isSafeInteger(awardedUnitsInUtcMonth) || awardedUnitsInUtcMonth < 0)
    throw new Error('PC_ECON2_INVALID_MONTHLY_UNITS');
  const catalogPlan = APPROVED_SUBSCRIPTION_CATALOG.find(x => x.key === snapshot.planKey);
  const rate = Object.prototype.hasOwnProperty.call(
    PROPOSED_PROGRESSIVE_EARNING_RATES, snapshot.planKey,
  ) ? PROPOSED_PROGRESSIVE_EARNING_RATES[
    snapshot.planKey as ProposedEarningPlan
  ] : 0;
  const valid = Boolean(
    catalogPlan && catalogPlan.isActive &&
    catalogPlan.currency === 'usd' && catalogPlan.priceMonthlyCents > 0 &&
    snapshot.subscriptionId && snapshot.planId && snapshot.businessId &&
    snapshot.stripeCustomerId.startsWith('cus_') &&
    snapshot.stripeSubscriptionId.startsWith('sub_') &&
    snapshot.stripePriceId.startsWith('price_') &&
    snapshot.billingInterval === 'month' &&
    snapshot.activeAtFulfillment &&
    Number.isFinite(snapshot.fulfillmentAt.getTime()),
  );
  const candidateUnits = valid ? rate : 0;
  // Preserve the agreed unit cap, not ten awards. Never silently grant
  // partial units for a qualifying settlement at the cap boundary.
  const awardableUnits = candidateUnits > 0 &&
    awardedUnitsInUtcMonth + candidateUnits <= PROPOSED_MONTHLY_UNIT_CAP
    ? candidateUnits : 0;
  return {
    policyVersion: PROPOSED_POLICY_VERSION,
    candidateUnits,
    awardableUnits,
    state: !candidateUnits ? 'not_eligible' : awardableUnits ? 'candidate' : 'cap_exceeded',
    historicalTierVerified: false,
    issuanceAuthorized: false,
  };
}

/** Full-threshold, business-requested invoice redemption quote.
 * Invoice fees are eligible USD pre-tax subscription fees ONLY; verify
 * the amount and eligibility with Stripe before permitting any application.
 */
export function quoteProgressiveRedemption(input: {
  eligibleInvoiceCents: number;
  vestedUnexpiredAvailableUnits: number;
  currency: string;
}): {
  requiredUnits: number;
  discountCents: number;
  remainingEligibleFeeCents: number;
  eligibleToRequest: boolean;
  providerAmountVerified: false;
  redemptionAuthorized: false;
} {
  const { eligibleInvoiceCents: cents, vestedUnexpiredAvailableUnits: available, currency } = input;
  if (!Number.isSafeInteger(cents) || cents < 0 ||
      !Number.isSafeInteger(available) || available < 0 ||
      currency !== 'usd')
    throw new Error('PC_ECON2_REDEMPTION_QUOTE_INVALID');
  // Integer math means the discount NEVER exceeds 30% and never consumes
  // fractional $1 credits. The unused fraction of a dollar is not redeemed.
  const requiredUnits = Math.floor((cents * PROPOSED_DISCOUNT_PERCENT) /
    (100 * PROPOSED_USD_CENTS_PER_UNIT));
  const eligibleToRequest = requiredUnits > 0 && available >= requiredUnits;
  const discountCents = eligibleToRequest
    ? requiredUnits * PROPOSED_USD_CENTS_PER_UNIT : 0;
  return {
    requiredUnits,
    discountCents,
    remainingEligibleFeeCents: cents - discountCents,
    eligibleToRequest,
    providerAmountVerified: false,
    redemptionAuthorized: false,
  };
}
