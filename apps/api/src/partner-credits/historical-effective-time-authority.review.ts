/**
 * Split 07: explicit provider-source limitations and authority requirements.
 * This is an evidence classification contract, NEVER a tier or award grant.
 * Stripe event.created is event creation time, not proof of the instant when
 * a price became effective. Subscription item period start is a billing
 * boundary. Current schedule phases can be edited or released.
 */
export type HistoricalEffectiveTimeEvidence = Readonly<{
  businessId: string;
  customerId: string;
  subscriptionId: string;
  fulfillmentAt: Date;
  sources: readonly {
    kind: 'stripe_event_created' | 'stripe_item_period_start' |
      'current_schedule_phase' | 'retained_event_history' |
      'immutable_provider_transition_receipt';
    providerRef: string;
    effectiveAt: Date | null;
    immutableCapture: boolean;
    completeFromSubscriptionInception: boolean;
  }[];
}>;

export type HistoricalAuthorityReview = Readonly<{
  historicalTierVerified: false;
  issuanceAuthorized: false;
  reason: 'INVALID_INPUT' | 'NO_EVIDENCE' | 'IDENTITY_OR_TIME_INVALID' |
    'UNPROVEN_TRANSITION_AUTHORITY' | 'HISTORICAL_COMPLETENESS_UNPROVEN';
  candidateTransitionRefs: readonly string[];
}>;

export function reviewHistoricalEffectiveTimeAuthority(
  input: HistoricalEffectiveTimeEvidence,
): HistoricalAuthorityReview {
  const deny = (reason: HistoricalAuthorityReview['reason'], refs: string[] = []): HistoricalAuthorityReview =>
    ({ historicalTierVerified:false, issuanceAuthorized:false, reason, candidateTransitionRefs:refs });
  if (!input.businessId || !input.customerId.startsWith('cus_') ||
      !input.subscriptionId.startsWith('sub_') ||
      !(input.fulfillmentAt instanceof Date) || !Number.isFinite(input.fulfillmentAt.getTime()))
    return deny('INVALID_INPUT');
  if (!input.sources.length) return deny('NO_EVIDENCE');
  const refs: string[] = [];
  let coverageClaimed = false;
  for (const source of input.sources) {
    if (!source.providerRef || (source.effectiveAt !== null &&
        (!(source.effectiveAt instanceof Date) || !Number.isFinite(source.effectiveAt.getTime()))))
      return deny('IDENTITY_OR_TIME_INVALID');
    if (source.kind === 'immutable_provider_transition_receipt' &&
        source.immutableCapture && source.effectiveAt !== null)
      refs.push(source.providerRef);
    if (source.completeFromSubscriptionInception) coverageClaimed = true;
  }
  // "Complete" is merely a self-reported boolean until an independently
  // validated provider-history completeness contract exists. Even receipts
  // are only candidates and cannot override the frozen economic SQL gates.
  if (!refs.length) return deny('UNPROVEN_TRANSITION_AUTHORITY');
  return deny(coverageClaimed ? 'HISTORICAL_COMPLETENESS_UNPROVEN' :
    'HISTORICAL_COMPLETENESS_UNPROVEN', refs);
}
