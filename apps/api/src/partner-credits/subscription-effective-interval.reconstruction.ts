/**
 * Split 07/08: reconstruct price intervals from Stripe subscription schedule
 * phase boundaries WITHOUT granting award authority.
 *
 * A schedule phase start/end is an explicit configured schedule boundary.
 * However, a current schedule can have been updated/released and cannot,
 * by itself, prove complete historical price state (including unscheduled
 * mid-cycle changes). The caller cannot assert verified history.
 */
export type ProviderSchedulePhaseEvidence = {
  scheduleId: string;
  subscriptionId: string;
  customerId: string;
  businessId: string;
  phaseStartSeconds: number;
  phaseEndSeconds: number;
  priceId: string;
  interval: 'month' | 'year';
  currency: string;
  itemCount: number;
  capturedProviderEventId: string;
};

export type PriceIntervalCandidate = {
  startUtc: string;
  endUtc: string;
  priceId: string;
  sourceScheduleId: string;
  sourceEventId: string;
};
export type IntervalReconstruction = {
  historicalTierVerified: false;
  issuanceAuthorized: false;
  reason: 'INVALID_INPUT' | 'ABSENT_PHASE_HISTORY' | 'IDENTITY_MISMATCH' |
    'UNSUPPORTED_PHASE' | 'INCONSISTENT_PHASES' | 'UNPROVEN_HISTORICAL_COMPLETENESS';
  candidates: PriceIntervalCandidate[];
  candidateAtFulfillment: PriceIntervalCandidate | null;
};

const safeInstant = (seconds: number): boolean =>
  Number.isSafeInteger(seconds) && seconds >= 0 && seconds < 8640000000000;

export function reconstructSchedulePriceIntervals(input: {
  businessId: string;
  customerId: string;
  subscriptionId: string;
  fulfillmentAt: Date;
  phases: readonly ProviderSchedulePhaseEvidence[];
}): IntervalReconstruction {
  const deny = (
    reason: IntervalReconstruction['reason'],
    candidates: PriceIntervalCandidate[] = [],
    candidateAtFulfillment: PriceIntervalCandidate | null = null,
  ): IntervalReconstruction => ({
    historicalTierVerified: false,
    issuanceAuthorized: false,
    reason,
    candidates,
    candidateAtFulfillment,
  });
  if (!input.businessId || !input.customerId.startsWith('cus_') ||
      !input.subscriptionId.startsWith('sub_') ||
      !(input.fulfillmentAt instanceof Date) ||
      !Number.isFinite(input.fulfillmentAt.getTime())) return deny('INVALID_INPUT');
  if (!input.phases.length) return deny('ABSENT_PHASE_HISTORY');

  const sorted = [...input.phases].sort((a, b) =>
    a.phaseStartSeconds - b.phaseStartSeconds ||
    a.phaseEndSeconds - b.phaseEndSeconds ||
    a.capturedProviderEventId.localeCompare(b.capturedProviderEventId));
  const candidates: PriceIntervalCandidate[] = [];
  let previousEnd: number | null = null;
  let scheduleId: string | null = null;
  for (const p of sorted) {
    if (p.businessId !== input.businessId ||
        p.customerId !== input.customerId ||
        p.subscriptionId !== input.subscriptionId) return deny('IDENTITY_MISMATCH');
    if (!p.scheduleId.startsWith('sub_sched_') ||
        !p.capturedProviderEventId.startsWith('evt_') ||
        !p.priceId.startsWith('price_') ||
        p.itemCount !== 1 || p.interval !== 'month' ||
        p.currency.toLowerCase() !== 'usd') return deny('UNSUPPORTED_PHASE');
    if (!safeInstant(p.phaseStartSeconds) || !safeInstant(p.phaseEndSeconds) ||
        p.phaseStartSeconds >= p.phaseEndSeconds ||
        (scheduleId !== null && scheduleId !== p.scheduleId) ||
        (previousEnd !== null && previousEnd !== p.phaseStartSeconds))
      return deny('INCONSISTENT_PHASES');
    scheduleId = p.scheduleId;
    previousEnd = p.phaseEndSeconds;
    candidates.push({
      startUtc: new Date(p.phaseStartSeconds * 1000).toISOString(),
      endUtc: new Date(p.phaseEndSeconds * 1000).toISOString(),
      priceId: p.priceId,
      sourceScheduleId: p.scheduleId,
      sourceEventId: p.capturedProviderEventId,
    });
  }
  const at = candidates.filter(c =>
    Date.parse(c.startUtc) <= input.fulfillmentAt.getTime() &&
    input.fulfillmentAt.getTime() < Date.parse(c.endUtc));
  if (at.length > 1) return deny('INCONSISTENT_PHASES');
  // Even complete contiguous schedule phases do not prove absence of
  // intervening immediate price updates. Retrospective provider reconciliation
  // and a completeness authority are required in a separately gated block.
  return deny('UNPROVEN_HISTORICAL_COMPLETENESS', candidates, at[0] ?? null);
}
