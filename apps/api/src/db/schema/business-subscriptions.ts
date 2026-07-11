import { pgTable, uuid, text, timestamp, boolean, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { subscriptionPlans } from './subscription-plans';
import { auditColumns } from './_shared';

/**
 * One row per business, tracking what it's subscribed to on the platform's
 * own SaaS billing (see subscription-plans.ts's schema comment for the
 * "platform billing, not customer loyalty" distinction). Stripe remains the
 * system of record for payment methods and invoice line items (surfaced to
 * a business owner via a Stripe-hosted Customer Portal session, Billing
 * Block 9) -- this table is a read-optimized MIRROR of subscription state
 * only, kept in sync by billing/stripe-webhook.routes.ts, so the dashboard
 * never needs a live Stripe API call just to render "you're on the Growth
 * plan, renews July 20."
 *
 * status intentionally mirrors Stripe's own Subscription.status vocabulary
 * 1:1 (trialing/active/past_due/canceled/incomplete/incomplete_expired/
 * unpaid) rather than a platform-invented simplification, so there is
 * exactly one status vocabulary to reason about across this table, the
 * Stripe dashboard, and Stripe's own docs -- translating between two
 * parallel enums would be pure accidental complexity.
 *
 * stripeCustomerId/stripeSubscriptionId are nullable: a business starts in
 * a card-less trial (see billing/subscription-provisioning.service.ts) with
 * neither populated, only filled in once Stripe Checkout actually completes
 * (customer.subscription.created webhook).
 */
export const businessSubscriptions = pgTable(
  'business_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    // RESTRICT, not CASCADE: an active/historical subscription must never be
    // silently orphaned by a plan row disappearing -- pairs with
    // subscription-plans.ts's "never hard-deleted, isActive=false instead"
    // convention, so this constraint should never actually fire in practice.
    planId: uuid('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    status: text('status').notNull().default('trialing'),
    billingInterval: text('billing_interval'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    ...auditColumns,
  },
  (table) => [
    // One subscription per business -- also what the webhook sync's upsert
    // (ON CONFLICT (business_id)) relies on.
    uniqueIndex('business_subscriptions_business_id_key').on(table.businessId),
    index('business_subscriptions_stripe_customer_id_idx').on(table.stripeCustomerId),
    index('business_subscriptions_stripe_subscription_id_idx').on(table.stripeSubscriptionId),
    // Supports a future platform-admin billing dashboard (Block 10) filtering
    // by status (e.g. "show me every past_due business") without a full scan.
    index('business_subscriptions_status_idx').on(table.status),
    check(
      'business_subscriptions_status_check',
      sql`${table.status} IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid')`,
    ),
    check(
      'business_subscriptions_billing_interval_check',
      sql`${table.billingInterval} IS NULL OR ${table.billingInterval} IN ('month', 'year')`,
    ),
  ],
);
