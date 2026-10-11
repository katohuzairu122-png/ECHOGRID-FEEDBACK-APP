import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { businessSubscriptions, stripeSubscriptionTierObservations } from '../db/schema';

const TYPES = new Set(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted']);

/**
 * Must only be invoked AFTER signature verification of the raw Stripe webhook.
 * Stores provider evidence, never a purported historical effective-price interval.
 * Skips events that are not tied to a matching local business subscription.
 */
export async function recordVerifiedStripeSubscriptionObservation(db: Database, event: Stripe.Event): Promise<'stored' | 'replayed' | 'skipped'> {
  if (!TYPES.has(event.type)) return 'skipped';
  const subscription = event.data.object as Stripe.Subscription;
  const businessId = subscription.metadata?.businessId;
  const items = subscription.items?.data;
  const item = items?.length === 1 ? items[0] : undefined;
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const price = item?.price;
  const interval = price?.recurring?.interval;
  const start = item?.current_period_start;
  const end = item?.current_period_end;
  if (!businessId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId) ||
      !event.id?.startsWith('evt_') || !Number.isSafeInteger(event.created) ||
      !subscription.id?.startsWith('sub_') || !customer?.startsWith('cus_') ||
      !price?.id?.startsWith('price_') || !item || !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) || start! >= end!) return 'skipped';

  // Avoid persisting cross-tenant spoofed metadata as tenant-owned evidence.
  const [mirror] = await db.select().from(businessSubscriptions).where(eq(businessSubscriptions.businessId,businessId)).limit(1);
  if (!mirror || mirror.stripeSubscriptionId !== subscription.id || mirror.stripeCustomerId !== customer) return 'skipped';

  const [inserted] = await db.insert(stripeSubscriptionTierObservations).values({
    stripeEventId: event.id, stripeEventCreatedAt: new Date(event.created * 1000),
    stripeEventType: event.type, businessId, stripeCustomerId: customer,
    stripeSubscriptionId: subscription.id, stripePriceId: price.id,
    status: subscription.status, billingInterval: interval === 'month' || interval === 'year' ? interval : 'unknown',
    itemPeriodStart: new Date(start! * 1000), itemPeriodEnd: new Date(end! * 1000),
    // Keep original signed subscription object for independent later reconciliation.
    providerPayload: subscription as unknown as Record<string, unknown>,
  }).onConflictDoNothing({ target: stripeSubscriptionTierObservations.stripeEventId }).returning({id:stripeSubscriptionTierObservations.id});
  return inserted ? 'stored' : 'replayed';
}
