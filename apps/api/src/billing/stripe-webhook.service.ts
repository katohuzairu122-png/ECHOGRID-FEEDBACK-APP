import type Stripe from 'stripe';
import type { Repositories } from '../repositories';
import type { StripeSyncPatch } from '../repositories/business-subscription.repository';

/**
 * Processes verified Stripe webhook events (signature check happens in
 * stripe-webhook.routes.ts, before this is ever called) and syncs
 * business_subscriptions to match. Deliberately reacts ONLY to
 * customer.subscription.* events, not checkout.session.completed --
 * Stripe fires customer.subscription.created as part of completing a
 * subscription-mode Checkout anyway, and subscriptions can also be created/
 * modified outside Checkout entirely (the Customer Portal, the Stripe
 * Dashboard, a future admin tool), so subscription events are the one
 * source of truth this service needs, rather than two upsert code paths
 * that could disagree.
 *
 * Idempotent by construction, not by an event-ID dedup table: every handler
 * below does an absolute-state upsert (ON CONFLICT (business_id) DO UPDATE,
 * see BusinessSubscriptionRepository.upsertFromStripe), so replaying the
 * same event twice reapplies the same state and changes nothing. A
 * dedicated stripe_events ledger would be warranted for anything that
 * INCREMENTS a value (e.g. loyalty points on a payment) -- pure
 * state-mirroring like this does not carry that risk, a deliberate v1 scope
 * decision, not an oversight.
 */
export class StripeWebhookService {
  constructor(
    private readonly repos: Pick<Repositories, 'subscriptionPlans' | 'businessSubscriptions' | 'auditLog'>,
  ) {}

  async processEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.syncSubscription(event.data.object as Stripe.Subscription);
        return;
      case 'customer.subscription.deleted':
        await this.syncSubscription(event.data.object as Stripe.Subscription, { forceCanceled: true });
        return;
      default:
        // Every other event type (invoices, payment methods, disputes, ...)
        // is intentionally unhandled in this v1 -- Stripe's Dashboard/email
        // receipts already cover payment-level visibility, and every
        // subscription-state consequence of those events (e.g. a failed
        // invoice payment eventually flips status to past_due) already
        // arrives via customer.subscription.updated, handled above.
        return;
    }
  }

  private async syncSubscription(
    subscription: Stripe.Subscription,
    opts: { forceCanceled?: boolean } = {},
  ): Promise<void> {
    const businessId = subscription.metadata?.businessId;
    if (!businessId) {
      // Not one of ours -- e.g. a subscription created directly in the
      // Stripe Dashboard without going through createCheckoutSession's
      // subscription_data.metadata. Nothing to sync against; log and move
      // on rather than throwing, so one unrelated event never fails the
      // whole webhook delivery (Stripe retries on non-2xx, which would
      // otherwise retry forever for an event this service can never handle).
      console.warn('Stripe subscription event with no businessId metadata, skipping:', subscription.id);
      return;
    }

    // items.data[0], not the top-level subscription object -- Stripe's
    // Basil API version (2025-03-31) moved current_period_start/end off
    // Subscription onto each SubscriptionItem as part of supporting
    // multi-item subscriptions with independent billing periods (confirmed
    // via live search, 2026-07-11: see Stripe's changelog). Always exactly
    // one item here since createCheckoutSession (billing.service.ts) only
    // ever creates single-line-item subscriptions, so "the first item's
    // period" is unambiguous -- a multi-item subscription would need a
    // real policy decision this codebase doesn't need yet.
    const item = subscription.items.data[0];
    const priceId = item?.price?.id;
    const interval = item?.price?.recurring?.interval === 'year' ? 'year' : 'month';
    const status = opts.forceCanceled ? 'canceled' : subscription.status;

    const plan = priceId ? await this.repos.subscriptionPlans.findByStripePriceId(priceId) : undefined;
    // Falls back to whatever planId Checkout stashed in subscription
    // metadata if the live price-ID lookup can't resolve a plan (e.g. a
    // price was deleted from Stripe out of band) -- resolved BEFORE
    // building `patch` so planId is a definite string by the time the
    // strictly-typed StripeSyncPatch object below is constructed, not an
    // optional field TypeScript would otherwise have to worry about.
    const planId = plan?.id ?? subscription.metadata?.planId;

    if (!planId) {
      console.error(
        `Stripe subscription ${subscription.id} for business ${businessId} resolved to no plan ` +
          `(price ${priceId ?? 'unknown'} not found in subscription_plans and no metadata.planId fallback) -- skipping sync.`,
      );
      return;
    }

    const patch: StripeSyncPatch = {
      planId,
      stripeCustomerId:
        typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
      stripeSubscriptionId: subscription.id,
      status,
      billingInterval: interval,
      currentPeriodStart: item?.current_period_start ? new Date(item.current_period_start * 1000) : null,
      currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      // Prefer Stripe's own recorded cancellation instant over "now" -- only
      // customer.subscription.deleted (forceCanceled) lacks one (the
      // Subscription object itself is being torn down), where "now" is the
      // correct fallback.
      canceledAt: opts.forceCanceled
        ? new Date()
        : subscription.canceled_at
          ? new Date(subscription.canceled_at * 1000)
          : null,
    };

    await this.repos.businessSubscriptions.upsertFromStripe(businessId, patch);

    try {
      await this.repos.auditLog.record({
        businessId,
        actorUserId: null,
        action: `subscription.${status}`,
        entityType: 'business_subscription',
        entityId: null,
        metadata: { stripeSubscriptionId: subscription.id, status },
        ipAddress: null,
        userAgent: 'stripe-webhook',
      });
    } catch (err) {
      // Same "never let an audit-write failure break the actual operation"
      // guarantee as middleware/audit.ts -- the subscription sync above
      // already succeeded and must not be rolled back over a logging issue.
      console.error('Failed to write audit log entry for Stripe subscription sync:', err);
    }
  }
}
