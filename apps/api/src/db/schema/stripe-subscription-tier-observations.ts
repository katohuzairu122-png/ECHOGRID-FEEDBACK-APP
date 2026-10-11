import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';

/** Immutable Stripe-signed webhook observations, NOT verified historical effective windows. */
export const stripeSubscriptionTierObservations = pgTable('stripe_subscription_tier_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  stripeEventId: text('stripe_event_id').notNull().unique(),
  stripeEventCreatedAt: timestamp('stripe_event_created_at', { withTimezone: true }).notNull(),
  stripeEventType: text('stripe_event_type').notNull(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, {onDelete:'restrict'}),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id').notNull(),
  stripePriceId: text('stripe_price_id').notNull(),
  status: text('status').notNull(),
  billingInterval: text('billing_interval').notNull(),
  itemPeriodStart: timestamp('item_period_start', {withTimezone:true}),
  itemPeriodEnd: timestamp('item_period_end', {withTimezone:true}),
  providerPayload: jsonb('provider_payload').$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp('received_at', {withTimezone:true}).notNull().defaultNow(),
}, t => [
  index('stripe_tier_observation_business_event_idx').on(t.businessId, t.stripeEventCreatedAt),
  index('stripe_tier_observation_subscription_event_idx').on(t.stripeSubscriptionId, t.stripeEventCreatedAt),
  check('stripe_tier_observation_event_type_check', sql`${t.stripeEventType} IN ('customer.subscription.created','customer.subscription.updated','customer.subscription.deleted')`),
  check('stripe_tier_observation_interval_check', sql`${t.billingInterval} IN ('month','year','unknown')`),
  check('stripe_tier_observation_period_order', sql`${t.itemPeriodStart} IS NULL OR ${t.itemPeriodEnd} IS NULL OR ${t.itemPeriodEnd} > ${t.itemPeriodStart}`),
]);
