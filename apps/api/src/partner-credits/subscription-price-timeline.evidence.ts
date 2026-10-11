/**
 * Split 07/08 historical price timeline: structural screening only.
 * Stripe event creation and billing-period timestamps are observations,
 * NOT authoritative price-effective boundaries. No successful issuance here.
 */
export interface PriceTimelineObservation {
  eventId: string;
  eventCreatedAt: Date;
  businessId: string;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  interval: 'month' | 'year' | 'unknown';
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  providerCorroborated: boolean;
}
export type PriceTimelineAssessment = {
  historicalTierVerified: false;
  issuanceAuthorized: false;
  reason: 'INVALID_INPUT' | 'HISTORY_ABSENT' | 'PROVIDER_NOT_CORROBORATED' |
    'IDENTITY_CONFLICT' | 'DUPLICATE_EVENT_CONFLICT' | 'TIMELINE_AMBIGUOUS' |
    'UNSUPPORTED_BILLING_STATE' | 'EFFECTIVE_WINDOW_UNPROVEN';
  candidatePriceIds: string[];
};

/**
 * Deterministic screening of unordered observations. An event log does not
 * prove completeness; even a single matching price cannot be promoted into
 * an effective-time attestation without separate Stripe-authoritative evidence.
 */
export function assessPriceTimeline(input: {
  businessId: string;
  customerId: string;
  subscriptionId: string;
  fulfilledAt: Date;
  observations: readonly PriceTimelineObservation[];
}): PriceTimelineAssessment {
  const result = (reason: PriceTimelineAssessment['reason'], ids: string[] = []): PriceTimelineAssessment => ({
    historicalTierVerified: false, issuanceAuthorized: false, reason, candidatePriceIds: ids,
  });
  if (!input.businessId || !input.customerId.startsWith('cus_') ||
      !input.subscriptionId.startsWith('sub_') ||
      !Number.isFinite(input.fulfilledAt.getTime())) return result('INVALID_INPUT');
  if (!input.observations.length) return result('HISTORY_ABSENT');
  const seen = new Map<string, string>();
  const prices = new Set<string>();
  for (const o of input.observations) {
    if (!o.eventId.startsWith('evt_') || !Number.isFinite(o.eventCreatedAt.getTime()) ||
        !o.priceId.startsWith('price_')) return result('INVALID_INPUT');
    if (o.businessId !== input.businessId || o.customerId !== input.customerId ||
        o.subscriptionId !== input.subscriptionId) return result('IDENTITY_CONFLICT');
    if (!o.providerCorroborated) return result('PROVIDER_NOT_CORROBORATED');
    const fingerprint = JSON.stringify([
      o.eventCreatedAt.toISOString(), o.businessId, o.customerId, o.subscriptionId,
      o.priceId, o.interval, o.status, o.periodStart?.toISOString(), o.periodEnd?.toISOString(),
    ]);
    const previous = seen.get(o.eventId);
    if (previous && previous !== fingerprint) return result('DUPLICATE_EVENT_CONFLICT');
    seen.set(o.eventId, fingerprint);
    if (o.eventCreatedAt <= input.fulfilledAt) prices.add(o.priceId);
  }
  const ids = [...prices].sort();
  if (!ids.length) return result('EFFECTIVE_WINDOW_UNPROVEN');
  if (ids.length > 1) return result('TIMELINE_AMBIGUOUS', ids);
  // 'active' and 'month' are only structural screens, not tier entitlement.
  const candidates = input.observations.filter(o =>
    o.eventCreatedAt <= input.fulfilledAt && o.priceId === ids[0]);
  if (candidates.some(o => o.interval !== 'month' || o.status !== 'active'))
    return result('UNSUPPORTED_BILLING_STATE', ids);
  return result('EFFECTIVE_WINDOW_UNPROVEN', ids);
}
