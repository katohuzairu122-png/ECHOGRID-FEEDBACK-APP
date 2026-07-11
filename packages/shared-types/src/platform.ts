import { z } from 'zod';
import { subscriptionStatusSchema, billingIntervalSchema } from './billing';

/**
 * Platform Admin Console's shared request/response contract (Blocks 2-3).
 * Separate file from businesses.ts/feedback.ts on purpose -- those describe
 * the tenant-facing contract (a business viewing/editing itself, a customer
 * submitting feedback); this describes the cross-tenant contract a platform
 * admin's console UI (Block 5+) consumes. Same entity, different audience
 * and privilege level, so the shapes are intentionally NOT reused from each
 * other -- see platformBusinessSchema's comment below.
 */

export const updateBusinessStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'archived']),
  // Not persisted onto businesses itself (no column for it) -- carried
  // through to the audit_log entry's metadata (see business-directory.routes.ts)
  // so "why was this business suspended" is answerable later without a
  // separate notes table.
  reason: z.string().trim().max(500).optional(),
});

export type UpdateBusinessStatusInput = z.infer<typeof updateBusinessStatusSchema>;

/**
 * Platform admin's view of a business -- a superset of businessSchema
 * (businesses.ts), not a reuse of it: an admin legitimately needs fields
 * (legalName, industry, createdAt) that the tenant-facing contract has no
 * reason to expose, and widening businessSchema itself would leak those
 * fields into the ordinary business-facing API. Duplication here is
 * deliberate -- the two schemas serve different privilege levels and are
 * allowed to diverge independently as each surface evolves.
 */
export const platformBusinessSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  legalName: z.string().nullable(),
  industry: z.string().nullable(),
  defaultLocale: z.string(),
  defaultCurrency: z.string(),
  defaultTimezone: z.string(),
  status: z.enum(['active', 'suspended', 'archived']),
  createdAt: z.string(),
});

export type PlatformBusinessDto = z.infer<typeof platformBusinessSchema>;

/**
 * A business's team, hydrated (Block 4) -- backs both the impersonation
 * target picker and general "who has access here" viewing. userId is what
 * POST /platform/businesses/:id/impersonate's body expects.
 */
export const platformTeamMemberSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  userEmail: z.string(),
  userFullName: z.string(),
  roleId: z.uuid(),
  roleName: z.string(),
  branchId: z.uuid().nullable(),
});

export type PlatformTeamMemberDto = z.infer<typeof platformTeamMemberSchema>;

/**
 * Impersonation request (Block 4). `reason` is required, unlike
 * updateBusinessStatusSchema's optional one -- assuming another user's full
 * identity is a materially more sensitive action than flipping a status
 * flag, so the audit trail should never have an unexplained entry for it.
 */
export const impersonateSchema = z.object({
  userId: z.uuid(),
  reason: z.string().trim().min(1, { error: 'A reason is required.' }).max(500),
});

export type ImpersonateInput = z.infer<typeof impersonateSchema>;

/**
 * Response for a successful impersonation request -- a short-lived access
 * token (no refresh token, see auth/jwt.ts's IMPERSONATION_TOKEN_TTL_SECONDS)
 * plus enough of the target's identity for the console UI to show "you are
 * viewing as <name>" without a second round trip.
 */
export const impersonationResultSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  targetUser: z.object({
    id: z.uuid(),
    email: z.string(),
    fullName: z.string(),
  }),
});

export type ImpersonationResultDto = z.infer<typeof impersonationResultSchema>;

/**
 * Cross-tenant audit log entry, hydrated (Block 6 -- originally shipped
 * unhydrated in Block 3, widened here once the console's audit screen
 * needed it to be readable rather than three raw foreign keys). businessName/
 * actorEmail/actorFullName are independently nullable from businessId/
 * actorUserId themselves: an entry can reference a business or user that
 * was since soft-deleted, or (system/anonymous-attributed entries) have no
 * actor at all.
 */
export const platformAuditLogEntrySchema = z.object({
  id: z.uuid(),
  businessId: z.uuid().nullable(),
  businessName: z.string().nullable(),
  actorUserId: z.uuid().nullable(),
  actorEmail: z.string().nullable(),
  actorFullName: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.uuid().nullable(),
  // Free-form details bag set by whichever route recorded the entry (see
  // middleware/audit.ts) -- shape intentionally varies per action, so this
  // stays an open record rather than a per-action union that would need to
  // grow every time a new audited action ships.
  metadata: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
});

export type PlatformAuditLogEntryDto = z.infer<typeof platformAuditLogEntrySchema>;

/**
 * Platform admin's view of a subscription plan (Billing Block 10) -- a
 * superset of billing.ts's subscriptionPlanSchema, not a reuse of it: same
 * audience-split reasoning as platformBusinessSchema vs businessSchema
 * above. A platform admin legitimately needs to see/edit the Stripe price
 * IDs and isActive/isDefaultTrial flags that the business-facing contract
 * deliberately excludes (see billing.ts's own comment on why those are
 * stripped there).
 */
export const platformSubscriptionPlanSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceMonthlyCents: z.number().int().nonnegative(),
  priceYearlyCents: z.number().int().nonnegative().nullable(),
  currency: z.string(),
  stripePriceIdMonthly: z.string().nullable(),
  stripePriceIdYearly: z.string().nullable(),
  maxBranches: z.number().int().nonnegative().nullable(),
  maxUsers: z.number().int().nonnegative().nullable(),
  isActive: z.boolean(),
  isDefaultTrial: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
});

export type PlatformSubscriptionPlanDto = z.infer<typeof platformSubscriptionPlanSchema>;

/** key is immutable once created (see db/schema/subscription-plans.ts's
 * "stable identifier independent of the display name" comment) -- present
 * only on create, never on update. */
export const createSubscriptionPlanSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, { error: 'Key may only contain lowercase letters, numbers, and hyphens.' })
    .min(2)
    .max(60),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  priceMonthlyCents: z.number().int().nonnegative(),
  priceYearlyCents: z.number().int().nonnegative().optional(),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/, { error: 'Must be a 3-letter lowercase ISO 4217 currency code.' })
    .default('usd'),
  stripePriceIdMonthly: z.string().trim().min(1).optional(),
  stripePriceIdYearly: z.string().trim().min(1).optional(),
  maxBranches: z.number().int().nonnegative().optional(),
  maxUsers: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
  isDefaultTrial: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export type CreateSubscriptionPlanInput = z.infer<typeof createSubscriptionPlanSchema>;

export const updateSubscriptionPlanSchema = createSubscriptionPlanSchema.omit({ key: true }).partial();

export type UpdateSubscriptionPlanInput = z.infer<typeof updateSubscriptionPlanSchema>;

/**
 * Cross-tenant subscription list entry (Billing Block 10) -- hydrated with
 * business/plan names the same way platformAuditLogEntrySchema is, for the
 * same reason (raw foreign keys aren't a readable list screen). businessName/
 * planName are NOT nullable here, unlike the audit log entry's: both FKs on
 * business_subscriptions are non-deferrable (CASCADE on businessId, RESTRICT
 * on planId -- see the schema comment), so a row can never outlive either
 * parent, unlike audit_log's deliberately-nullable SET NULL FKs.
 */
export const platformBusinessSubscriptionSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  businessName: z.string(),
  planId: z.uuid(),
  planName: z.string(),
  status: subscriptionStatusSchema,
  billingInterval: billingIntervalSchema.nullable(),
  currentPeriodEnd: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  createdAt: z.string(),
});

export type PlatformBusinessSubscriptionDto = z.infer<typeof platformBusinessSubscriptionSchema>;

/**
 * v1 simplification: assumes every plan is priced in the same currency
 * (true of the seed catalog) and sums raw cents across active subscriptions
 * without FX conversion. Real multi-currency MRR needs either a fixed
 * reporting currency with live conversion or a per-currency breakdown --
 * flagged here rather than silently assumed; revisit if/when a
 * non-USD-priced plan is actually added.
 */
export const platformMrrSummarySchema = z.object({
  mrrCents: z.number().int().nonnegative(),
  currency: z.string(),
  activeSubscriptionCount: z.number().int().nonnegative(),
});

export type PlatformMrrSummaryDto = z.infer<typeof platformMrrSummarySchema>;
