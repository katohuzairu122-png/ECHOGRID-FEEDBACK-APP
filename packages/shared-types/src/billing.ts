import { z } from 'zod';

/**
 * Platform SaaS billing contract (Billing Block 8) -- what a business pays
 * Echo Grid Feedback to use the platform. Not to be confused with loyalty.ts's
 * rewards/cashback/points, which describe a business's OWN loyalty program
 * for its customers; this file is the other side of the relationship.
 *
 * Deliberately excludes Stripe implementation details (stripeCustomerId,
 * stripeSubscriptionId, the Stripe Price IDs on a plan) from every schema
 * below -- the frontend never talks to Stripe directly, only receives
 * hosted-page redirect URLs from this API, so those identifiers are purely
 * an API-internal concern with no reason to leak into the wire contract.
 */

export const billingIntervalSchema = z.enum(['month', 'year']);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

/** Mirrors Stripe's own Subscription.status vocabulary 1:1 -- see the
 * schema comment on apps/api's business-subscriptions.ts for why. */
export const subscriptionStatusSchema = z.enum([
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const subscriptionPlanSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceMonthlyCents: z.number().int().nonnegative(),
  priceYearlyCents: z.number().int().nonnegative().nullable(),
  currency: z.string(),
  // Nullable = unlimited -- rendered as "Unlimited" by the plan picker, not
  // hard-coded as a magic sentinel number (see "never hard-code limits").
  maxBranches: z.number().int().nonnegative().nullable(),
  maxUsers: z.number().int().nonnegative().nullable(),
  features: z.record(z.string(), z.unknown()).nullable(),
  sortOrder: z.number().int(),
});

export type SubscriptionPlanDto = z.infer<typeof subscriptionPlanSchema>;

export const businessSubscriptionSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  planId: z.uuid(),
  status: subscriptionStatusSchema,
  billingInterval: billingIntervalSchema.nullable(),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  canceledAt: z.string().nullable(),
  // Derived from (internal, never-exposed) stripeCustomerId -- the billing
  // page needs to know whether "Manage billing" (Stripe Customer Portal) is
  // openable yet without needing the ID itself: a business still on a
  // card-less trial has no Stripe customer, and that button would 422.
  // Exposing the boolean fact instead of the ID is the least-privilege cut.
  hasPaymentAccount: z.boolean(),
});

export type BusinessSubscriptionDto = z.infer<typeof businessSubscriptionSchema>;

/** GET /billing/subscription's actual response shape -- the billing page
 * always needs plan details alongside subscription state (e.g. "Growth
 * plan, renews July 20"), so the plan is nested rather than requiring a
 * second round trip to GET /billing/plans and joining client-side. */
export const businessSubscriptionWithPlanSchema = businessSubscriptionSchema.extend({
  plan: subscriptionPlanSchema,
});

export type BusinessSubscriptionWithPlanDto = z.infer<typeof businessSubscriptionWithPlanSchema>;

/**
 * successUrl/cancelUrl are supplied by the caller (apps/web), not configured
 * on the API -- same "the web app knows its own base URL already" reasoning
 * already established for QR code URLs (see branches.ts), so the API never
 * needs its own copy of the frontend's deployed domain.
 */
export const createCheckoutSessionSchema = z.object({
  planId: z.uuid(),
  interval: billingIntervalSchema,
  successUrl: z.url(),
  cancelUrl: z.url(),
});

export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionSchema>;

export const createPortalSessionSchema = z.object({
  returnUrl: z.url(),
});

export type CreatePortalSessionInput = z.infer<typeof createPortalSessionSchema>;

/** Shared by both POST /billing/checkout and POST /billing/portal -- both
 * hand back nothing but a Stripe-hosted URL for the frontend to redirect
 * the browser to. */
export const billingSessionResultSchema = z.object({
  url: z.url(),
});

export type BillingSessionResultDto = z.infer<typeof billingSessionResultSchema>;
