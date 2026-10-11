import type Stripe from 'stripe';

/**
 * A provider event can independently prove an observed AFTER state, but Stripe
 * event.created is not necessarily the price-change effective instant.
 * This module derives non-authorizing upgrade/downgrade *evidence*, not awards.
 *
 * The raw event must have been retrieved from Stripe after matching an immutable
 * locally recorded observation; callers must never pass user-submitted events.
 */
export type ImmutableSubscriptionChangeEvidence = {
  eventId: string;
  providerRecordedAt: string;
  businessId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  previousPriceId: string | null;
  observedPriceId: string;
  changeDirection: 'price_changed_unknown_direction' | 'no_price_change_proven';
  effectiveAt: null;
  effectiveAtVerified: false;
  historicalTierVerified: false;
  issuanceAuthorized: false;
  reason: 'PROVIDER_EVENT_NOT_EFFECTIVE_TIME_AUTHORITY';
};

export type SubscriptionChangeEvidenceResult =
  | { kind: 'rejected'; reason: string; issuanceAuthorized: false }
  | { kind: 'observation'; evidence: ImmutableSubscriptionChangeEvidence };

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Provider event and stored evidence must match before calling this extractor.
 * Validate the expected tenant again at extraction to avoid evidence replay
 * across customers/businesses. Provider timestamps are audit observations.
 */
export function extractSubscriptionChangeEvidence(input: {
  event: Stripe.Event;
  businessId: string;
  customerId: string;
  subscriptionId: string;
  expectedPriceId: string;
  observationCorroborated: boolean;
}): SubscriptionChangeEvidenceResult {
  const reject = (reason: string): SubscriptionChangeEvidenceResult =>
    ({kind:'rejected',reason,issuanceAuthorized:false});
  const { event } = input;
  if (!input.observationCorroborated) return reject('SOURCE_NOT_CORROBORATED');
  if (event.type !== 'customer.subscription.updated' ||
      !event.id?.startsWith('evt_') || !Number.isSafeInteger(event.created) ||
      event.created < 0) return reject('EVENT_NOT_ELIGIBLE');
  const s = event.data.object as Stripe.Subscription;
  const customer = typeof s.customer === 'string' ? s.customer : s.customer?.id;
  if (!input.businessId || s.metadata?.businessId !== input.businessId ||
      !input.customerId.startsWith('cus_') || customer !== input.customerId ||
      !input.subscriptionId.startsWith('sub_') || s.id !== input.subscriptionId)
    return reject('IDENTITY_MISMATCH');
  const items = s.items?.data;
  const item = items?.length === 1 ? items[0] : undefined;
  if (!item || !item.price?.id?.startsWith('price_') ||
      item.price.id !== input.expectedPriceId)
    return reject('PRICE_MISMATCH_OR_UNSUPPORTED_ITEMS');

  // Stripe previous_attributes may signal a subscription update without
  // including an authoritative prior price for nested subscription items.
  // Never fabricate a previous tier from a prior event or cached mirror.
  const previous = (event.data as unknown as Record<string, unknown>).previous_attributes;
  let previousPriceId: string | null = null;
  if (isObject(previous) && isObject(previous.items) &&
      Array.isArray(previous.items.data) && previous.items.data.length === 1) {
    const oldItem: unknown = previous.items.data[0];
    if (isObject(oldItem) && isObject(oldItem.price) &&
        typeof oldItem.price.id === 'string' && oldItem.price.id.startsWith('price_'))
      previousPriceId = oldItem.price.id;
  }
  return {
    kind:'observation',
    evidence:{
      eventId:event.id,
      providerRecordedAt:new Date(event.created * 1000).toISOString(),
      businessId:input.businessId,
      stripeCustomerId:input.customerId,
      stripeSubscriptionId:input.subscriptionId,
      previousPriceId,
      observedPriceId:item.price.id,
      changeDirection:previousPriceId !== null && previousPriceId !== item.price.id
        ? 'price_changed_unknown_direction':'no_price_change_proven',
      effectiveAt:null,
      effectiveAtVerified:false,
      historicalTierVerified:false,
      issuanceAuthorized:false,
      reason:'PROVIDER_EVENT_NOT_EFFECTIVE_TIME_AUTHORITY',
    },
  };
}
