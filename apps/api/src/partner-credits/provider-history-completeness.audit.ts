/**
 * Split 07/08: negative-only historical Stripe evidence completeness audit.
 *
 * A paginated Stripe Events result (even has_more=false) is NOT a proof
 * that Stripe retained every historical subscription change. Events may
 * be outside the provider retention window, or a transition may be
 * unscheduled. This audit detects explicit gaps and conflicts, but NEVER
 * grants an effective-time attestation or authorizes issuance.
 */
export type CorroboratedChange = {
  eventId: string;
  createdSeconds: number;
  businessId: string;
  customerId: string;
  subscriptionId: string;
  observedPriceId: string;
  previousPriceId: string | null;
  providerCorroborated: boolean;
};
export type HistoryCompletenessAudit = {
  complete: false;
  historicalTierVerified: false;
  issuanceAuthorized: false;
  reason: 'INVALID_INPUT' | 'NOT_CORROBORATED' | 'IDENTITY_MISMATCH' |
    'EVENT_CONFLICT' | 'PRICE_CHAIN_GAP' | 'PRICE_CHAIN_CONFLICT' |
    'HISTORY_BOUNDS_UNKNOWN' | 'EFFECTIVE_TIME_UNPROVEN';
  orderedEventIds: string[];
};

export function auditSubscriptionHistory(input: {
  businessId: string;
  customerId: string;
  subscriptionId: string;
  fulfillmentSeconds: number;
  changes: readonly CorroboratedChange[];
  providerPaginationExhausted: boolean;
  providerRetentionCoversFulfillment: boolean;
}): HistoryCompletenessAudit {
  const deny = (reason: HistoryCompletenessAudit['reason'], ids: string[] = []): HistoryCompletenessAudit =>
    ({complete:false, historicalTierVerified:false, issuanceAuthorized:false, reason,orderedEventIds:ids});
  if (!input.businessId || !input.customerId.startsWith('cus_') ||
      !input.subscriptionId.startsWith('sub_') ||
      !Number.isSafeInteger(input.fulfillmentSeconds) || input.fulfillmentSeconds < 0)
    return deny('INVALID_INPUT');
  const ordered = [...input.changes].sort((a,b) =>
    a.createdSeconds-b.createdSeconds || a.eventId.localeCompare(b.eventId));
  // Distinct price states with identical second-resolution timestamps have
  // no provider-authoritative order. Fail before sorting can imply one.
  const timestampPrices = new Map<number,string>();
  for (const c of ordered) {
    const existing = timestampPrices.get(c.createdSeconds);
    if (existing !== undefined && existing !== c.observedPriceId)
      return deny('PRICE_CHAIN_CONFLICT');
    timestampPrices.set(c.createdSeconds,c.observedPriceId);
  }
  const seen = new Map<string,string>();
  const ids: string[] = [];
  let precedingPrice: string | null = null;
  let priorTimestamp: number | null = null;
  for (const c of ordered) {
    if (!c.eventId.startsWith('evt_') || !Number.isSafeInteger(c.createdSeconds) ||
        c.createdSeconds < 0 || !c.observedPriceId.startsWith('price_') ||
        (c.previousPriceId !== null && !c.previousPriceId.startsWith('price_')))
      return deny('INVALID_INPUT',ids);
    if (c.businessId !== input.businessId || c.customerId !== input.customerId ||
        c.subscriptionId !== input.subscriptionId) return deny('IDENTITY_MISMATCH',ids);
    if (!c.providerCorroborated) return deny('NOT_CORROBORATED',ids);
    const fingerprint = JSON.stringify(c);
    const previous = seen.get(c.eventId);
    if (previous !== undefined) {
      if (previous !== fingerprint) return deny('EVENT_CONFLICT',ids);
      continue; // identical replay
    }
    seen.set(c.eventId,fingerprint);
    ids.push(c.eventId);
    if (priorTimestamp === c.createdSeconds && precedingPrice !== c.observedPriceId)
      return deny('PRICE_CHAIN_CONFLICT',ids); // no authoritative ordering within same second
    if (precedingPrice !== null && c.previousPriceId === null)
      return deny('PRICE_CHAIN_GAP',ids);
    if (precedingPrice !== null && c.previousPriceId !== precedingPrice)
      return deny('PRICE_CHAIN_CONFLICT',ids);
    precedingPrice = c.observedPriceId;
    priorTimestamp = c.createdSeconds;
  }
  if (!input.providerPaginationExhausted || !input.providerRetentionCoversFulfillment ||
      !ordered.length) return deny('HISTORY_BOUNDS_UNKNOWN',ids);
  // Exhausting a retained Stripe events collection does not establish the
  // exact time when each price became effective or a complete pre-retention
  // history. Only an independently approved effective-time authority can.
  return deny('EFFECTIVE_TIME_UNPROVEN',ids);
}
