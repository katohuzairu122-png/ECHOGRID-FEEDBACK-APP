import { z } from 'zod';

/**
 * Digital Loyalty module contract -- request/response shapes shared between
 * apps/api and apps/web, covering both the staff dashboard (accounts,
 * settings, tiers, rewards, redemption confirmation) and the customer-facing
 * surface (join, check-in, redeem). Split from customer-auth.ts because that
 * file is identity-only; this is loyalty program data.
 */

// ---- Staff: points engine ----------------------------------------------

export const recordPurchaseSchema = z.object({
  purchaseAmount: z.number().positive().max(1_000_000),
});

/**
 * Bound on a single manual points adjustment, in either direction.
 *
 * Until this existed, `points` had no magnitude limit at all -- only "not
 * zero" -- while the sibling `recordPurchaseSchema` above already capped at
 * 1,000,000. That asymmetry mattered because `POST /loyalty/accounts/:id/adjust`
 * requires only `loyalty:manage`, which role-provisioning grants to Staff.
 * So the lowest-privilege staff role could mint an unbounded, redeemable
 * balance in one request.
 *
 * 100,000 is a bound, not a policy. It is deliberately far above any
 * plausible correction -- the earning defaults are 10 points per check-in,
 * 50 for a referral, 100 for a birthday, so this is ~10,000 check-ins'
 * worth -- and far below anything that could distort a balance
 * meaningfully. Erring generous is the cheap direction: a rejected
 * legitimate adjustment is a support ticket, an unbounded one is a
 * liability the business has to honour.
 *
 * It also protects the column. `loyalty_accounts.points` is a Postgres
 * `integer`, so the only ceiling before this was 2,147,483,647 -- beyond
 * which the insert fails with an out-of-range error rather than anything a
 * caller could interpret. A value just under it succeeded and made the
 * balance meaningless.
 *
 * What this does NOT decide: whether Staff should reach this route at all.
 * Moving it behind `rewards:manage` (as `PATCH /loyalty/settings` already
 * is) would match the reasoning role-provisioning.service.ts gives for
 * withholding that permission, but it is a product call about what a
 * counter-staff member can fix without a manager -- not a fix to smuggle in
 * behind a bounds check.
 */
export const MAX_POINTS_ADJUSTMENT = 100_000;

export const adjustPointsSchema = z.object({
  points: z
    .number()
    .int()
    .min(-MAX_POINTS_ADJUSTMENT)
    .max(MAX_POINTS_ADJUSTMENT)
    .refine((v) => v !== 0, { error: 'Adjustment cannot be zero.' }),
  notes: z.string().trim().max(500).optional(),
});

// ---- Staff: program configuration (tiers, rewards, settings) -----------

export const createTierSchema = z.object({
  name: z.string().trim().min(1).max(100),
  minPoints: z.number().int().min(0),
  benefits: z.string().trim().max(1000).optional(),
  sortOrder: z.number().int().min(0).optional(),
});
export const updateTierSchema = createTierSchema.partial();

// Continuing Development Block 6.1 (S6.1 Reward Panel fields) added ten
// campaign columns to loyalty_rewards -- schema-level only through Block
// 6.5, since nothing at this contract layer ever accepted them (the
// "config-API gap" flagged during Block 6.5 verification). This block
// closes that: every field below already has a real, enforced counterpart
// in apps/api/src/loyalty/loyalty-redemption.service.ts and a real DB
// CHECK constraint in apps/api/src/db/schema/loyalty-rewards.ts. The
// .refine() calls on both schemas below mirror those DB constraints (plus
// one -- points-type needing a cost -- that only ever lived as an
// application-level expectation, see LoyaltyRedemptionService.redeem()'s
// LOYALTY_REWARD_MISCONFIGURED guard) so a bad request 400s with a clear
// message instead of surfacing a raw Postgres error.
const rewardTypeSchema = z.enum(['points', 'discount', 'free_item', 'voucher']);
const rewardLimitPerSchema = z.enum(['receipt', 'visit', 'period']);
const rewardStatusSchema = z.enum(['active', 'inactive', 'paused']);

// Shared between create/update input so each field is defined exactly
// once. Not shared with loyaltyRewardSchema (the response DTO further
// below) -- rewardValue/maxBudget round-trip as decimal strings on output
// (see that schema's own comment) but are accepted as plain numbers here,
// converted server-side before the `numeric` column write (matches
// recordPurchaseSchema.purchaseAmount's existing convention above).
const rewardCampaignFields = {
  // Continuing Development Block 6.8.1 (S6.1 campaign config UI) widened
  // this from z.uuid().optional() to also accept an explicit `null`.
  // Discovered while wiring the staff-facing branch-scope <select>, not
  // assumed: .optional() alone means an UPDATE has no way to actively
  // clear an already-set branchId back to business-wide -- an omitted key
  // means "don't touch this column" (see convertCampaignFields' own
  // comment in loyalty-reward.service.ts), so sending nothing when a
  // business owner picks "All branches" would silently leave the reward
  // branch-scoped, contradicting their explicit choice. `null` now means
  // "clear it"; an omitted key still means "leave it alone" -- both
  // schemas keep working exactly as before for every caller that never
  // sends this field. Harmless on create (null behaves identically to
  // omitted there, nothing to clear yet).
  branchId: z.uuid().nullable().optional(),
  type: rewardTypeSchema.optional(),
  rewardValue: z.number().positive().max(1_000_000).optional(),
  startDate: z.iso.datetime().optional(),
  expiryDate: z.iso.datetime().optional(),
  // Continuing Development Block 6.8.3 (S6.1 campaign config UI) widened
  // these four plus limitPer below from .optional() to also accept an
  // explicit `null` -- identical reasoning and identical fix as branchId's
  // own Block 6.8.1 widening above: each is a genuine, standalone business
  // rule a manager sets and later removes (not a value that goes inert
  // when some sibling field changes, the way pointsCost/rewardValue do
  // with `type`), and an omitted key can only mean "leave it alone," never
  // "remove this limit." Harmless on create, same as branchId.
  maxRewardsPerDay: z.number().int().positive().nullable().optional(),
  maxBudget: z.number().positive().max(1_000_000).nullable().optional(),
  limitPer: rewardLimitPerSchema.nullable().optional(),
  limitPeriodDays: z.number().int().positive().nullable().optional(),
  cooldownSeconds: z.number().int().min(0).nullable().optional(),
  // Continuing Development Block 6.9 (S6.4 minimum feedback requirements).
  // Same clearable-standalone-setting treatment as maxRewardsPerDay/
  // cooldownSeconds above for minCommentLength (nullable at the DB layer,
  // so .nullable().optional() here too). requireVisitVerification is NOT
  // nullable at the DB layer (NOT NULL DEFAULT false -- see
  // loyalty-rewards.ts's own comment) -- there is no NULL state to
  // round-trip, so plain .optional() only: omitted leaves it alone,
  // `false` explicitly turns the requirement off, matching every other
  // boolean-shaped setting's "omission means don't touch" convention.
  minCommentLength: z.number().int().positive().nullable().optional(),
  requireVisitVerification: z.boolean().optional(),
};

export const createRewardSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).optional(),
    // Required only for a 'points'-type reward (the type's own default
    // when omitted) -- see the refine() below. Nullable at the DB/
    // repository level since Block 6.2 (non-points rewards don't have
    // one), but a 'points' reward created with no cost would be
    // unredeemable -- this stops that at creation instead of at a
    // customer's redeem attempt.
    pointsCost: z.number().int().positive().optional(),
    ...rewardCampaignFields,
  })
  .refine((val) => (val.type ?? 'points') !== 'points' || val.pointsCost !== undefined, {
    error: 'pointsCost is required for a points-type reward.',
  })
  .refine((val) => val.limitPer !== 'period' || val.limitPeriodDays !== undefined, {
    error: 'limitPeriodDays is required when limitPer is "period".',
  })
  .refine(
    (val) => {
      const { startDate, expiryDate } = val;
      return !startDate || !expiryDate || new Date(expiryDate) > new Date(startDate);
    },
    { error: 'expiryDate must be after startDate.' },
  );

// Independent object (not createRewardSchema.partial()) because a schema
// with .refine() attached is no longer a plain ZodObject and can't be
// .partial()'d -- see createRewardSchema's own refinements above. The
// three refine() rules here are deliberately patch-scoped, not full-state:
// each only fires when the patch itself is internally inconsistent (e.g.
// explicitly switching type to 'points' without also supplying a cost in
// that same request), never by fetching the row being patched -- the
// service layer doesn't do that lookup either (see loyalty-reward.service
// .ts). An ordinary partial update that never touches type/limitPer/the
// date pair is unaffected by any of the three.
export const updateRewardSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(1000).optional(),
    pointsCost: z.number().int().positive().optional(),
    status: rewardStatusSchema.optional(),
    ...rewardCampaignFields,
  })
  .refine((val) => val.type !== 'points' || val.pointsCost !== undefined, {
    error: 'pointsCost must be included in the same request when changing type to "points".',
  })
  .refine((val) => val.limitPer !== 'period' || val.limitPeriodDays !== undefined, {
    error: 'limitPeriodDays must be included in the same request when changing limitPer to "period".',
  })
  .refine(
    (val) => {
      const { startDate, expiryDate } = val;
      return !startDate || !expiryDate || new Date(expiryDate) > new Date(startDate);
    },
    { error: 'expiryDate must be after startDate.' },
  );

export const updateLoyaltySettingsSchema = z.object({
  pointsPerCheckin: z.number().int().min(0).optional(),
  pointsPerCurrencyUnit: z.number().min(0).optional(),
  referralBonusPoints: z.number().int().min(0).optional(),
  birthdayBonusPoints: z.number().int().min(0).optional(),
});

// ---- Customer-facing -----------------------------------------------------

export const joinLoyaltyProgramSchema = z.object({
  businessId: z.uuid(),
});

/** Check-in reuses the same anonymous QR token as feedback (qr_codes.token)
 * -- one QR code per branch drives both flows, distinguished by which
 * endpoint the scan lands on in apps/web. */
export const checkinSchema = z.object({
  qrToken: z.string().min(1),
  // Continuing Development Block 4.1 (S5.4 device velocity) -- same
  // contract as submitFeedbackSchema's field of the same name: client-
  // computed, only ever salted and hashed server-side, optional.
  deviceSignal: z.string().trim().max(256).optional(),
  // Continuing Development Block 4.3.2 (S5.3 visit verification) -- same
  // field/contract as submitFeedbackSchema's visitProof (feedback.ts):
  // optional, advisory only, unstructured at this layer.
  visitProof: z.string().trim().max(64).optional(),
});

// Continuing Development Block 2 (S6.1 limitPer='visit' + S6.4 minimum
// feedback requirements -- both need a feedback/visit reference threaded
// through redeem()/issue() before either can be enforced; this block only
// threads it, enforcement is a separate future block). Shared between
// redeemRewardSchema and issueRewardSchema below, same "define the fields
// once, spread into each schema" convention as rewardCampaignFields above --
// the two schemas stay independently-defined objects (not one derived from
// the other) since a .refine()'d schema can't be .partial()'d/extended the
// same way, matching createRewardSchema/updateRewardSchema's own precedent.
//
// All three fields optional: a redeem()/issue() call with none of them
// behaves exactly as before this block (fully backward compatible).
// feedbackId is validated for existence + tenant scope server-side
// (LoyaltyRedemptionService.resolveRedemptionReferences) -- no format
// beyond being a UUID is meaningful here. visitProof mirrors checkinSchema's
// field of the same name exactly (optional, advisory only, unstructured at
// this layer -- see that schema's own comment). branchId is new API
// surface: unlike checkin/feedback, redeem()/issue() have no QR scan to
// resolve a branchId from, so a visitProof needs the client to say which
// branch it's being claimed at.
const redemptionReferenceFields = {
  feedbackId: z.uuid().optional(),
  visitProof: z.string().trim().max(64).optional(),
  branchId: z.uuid().optional(),
};

export const redeemRewardSchema = z
  .object({
    rewardId: z.uuid(),
    ...redemptionReferenceFields,
  })
  .refine((val) => !val.visitProof || val.branchId !== undefined, {
    error: 'branchId is required when visitProof is provided.',
  });

/** Continuing Development Block 2 -- the non-points counterpart to
 * redeemRewardSchema, backing the new POST /loyalty/me/accounts/:businessId/
 * issue route. Same shape/refine as redeemRewardSchema above (both wrap
 * LoyaltyRedemptionService methods that now share one
 * RedemptionReferenceInput parameter) -- kept as a separate export rather
 * than reusing redeemRewardSchema by reference, matching this file's
 * existing RedemptionResult/IssuanceResult response-type separation
 * (see issuanceResultSchema below). */
export const issueRewardSchema = z
  .object({
    rewardId: z.uuid(),
    ...redemptionReferenceFields,
  })
  .refine((val) => !val.visitProof || val.branchId !== undefined, {
    error: 'branchId is required when visitProof is provided.',
  });

// ---- Response DTOs ---------------------------------------------------

export const loyaltyTierSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  name: z.string(),
  minPoints: z.number(),
  benefits: z.string().nullable(),
  sortOrder: z.number(),
});

// Widened alongside createRewardSchema/updateRewardSchema above (Block
// 6.1's ten campaign columns) -- correcting a real staleness, not adding
// new API surface: the API has always returned these columns (nothing
// prunes the JSON response against this schema, confirmed directly --
// it's a type used by apps/web, never a runtime validator), this DTO
// just didn't say so. rewardValue/maxBudget are `numeric(10,2)` columns,
// which come back as decimal strings, not numbers -- same reasoning as
// loyaltyTransactionSchema.purchaseAmount below.
export const loyaltyRewardSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  branchId: z.uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  type: rewardTypeSchema,
  pointsCost: z.number().nullable(),
  rewardValue: z.string().nullable(),
  status: rewardStatusSchema,
  startDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  maxRewardsPerDay: z.number().nullable(),
  maxBudget: z.string().nullable(),
  limitPer: rewardLimitPerSchema.nullable(),
  limitPeriodDays: z.number().nullable(),
  cooldownSeconds: z.number().nullable(),
  // Continuing Development Block 6.9 (S6.4) -- see rewardCampaignFields
  // above for the nullability reasoning behind each.
  minCommentLength: z.number().nullable(),
  requireVisitVerification: z.boolean(),
});

/** Block 6.7.2 (S6.3 campaign dashboard) -- GET /loyalty/rewards/:id/dashboard's
 * response. Mirrors LoyaltyRewardService.getCampaignDashboard()'s
 * CampaignDashboard interface
 * (apps/api/src/loyalty/loyalty-reward.service.ts) -- two independently-
 * defined, shape-compatible types, the same relationship
 * redemptionResultSchema/RedemptionResult already have below, not one
 * importing the other (that service file's own comment explains why).
 *
 * `reward` reuses loyaltyRewardSchema as-is -- the route returns the
 * reward row unmodified, same as GET /rewards already does today, so
 * rewardValue/maxBudget stay decimal STRINGS here too (the numeric
 * column's own JSON representation, unchanged from every other reward
 * response).
 *
 * `stats`'s four money/rate fields are plain NUMBERS, not that same
 * string convention, on purpose -- unlike reward.rewardValue/maxBudget,
 * these aren't a raw numeric-column passthrough: the service layer
 * computes and rounds them (roundMoney(), 2dp) before this schema ever
 * sees them, so there's no arbitrary-precision value to protect by
 * stringifying. Two different conventions inside one response -- flagged
 * here rather than left for a future reader to puzzle out.
 *
 * `branchName` was added while building the page that consumes this
 * (Block 6.7.3), not part of 6.7.2's original shape -- see
 * CampaignDashboard's own comment in loyalty-reward.service.ts for why a
 * server-resolved name beat a second client-side branch lookup. Additive
 * to an endpoint nothing else was consuming yet, so this amendment is
 * safe; recorded here rather than silently presented as if it shipped
 * with 6.7.2. */
export const campaignDashboardSchema = z.object({
  reward: loyaltyRewardSchema,
  branchName: z.string().nullable(),
  stats: z.object({
    totalCount: z.number(),
    outstandingCount: z.number(),
    redeemedCount: z.number(),
    redemptionRate: z.number().nullable(),
    budgetTotal: z.number().nullable(),
    budgetUsed: z.number().nullable(),
    budgetRemaining: z.number().nullable(),
    outstandingLiability: z.number().nullable(),
  }),
});

export const loyaltyAccountSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  businessId: z.uuid(),
  points: z.number(),
  tierId: z.uuid().nullable(),
  visitCount: z.number(),
  lastVisitAt: z.string().nullable(),
  status: z.enum(['active', 'suspended']),
});

/** Staff-only view of an account -- adds the customer's identifying info
 * (phone/name), which the customer's own view of their own account never
 * needs (they already know who they are). Kept as a distinct schema rather
 * than an optional field on loyaltyAccountSchema, so a type error catches
 * any accidental mixing of the two DTOs. */
export const loyaltyAccountWithCustomerSchema = loyaltyAccountSchema.extend({
  customer: z.object({
    id: z.uuid(),
    phone: z.string(),
    fullName: z.string().nullable(),
  }),
});

// Continuing Development Block 2 added visitSessionId/feedbackId below --
// correcting a real staleness, not adding new API surface, same reasoning
// as loyaltyRewardSchema's own Block 6.1 widening comment above: the API
// has always returned every column on the row (nothing prunes the JSON
// response against this schema), this DTO just didn't say so. visitSessionId
// specifically predates this block (Block 5.2) and was already missing here
// before Block 2 touched this file -- fixed in the same edit as the new
// feedbackId field since both are the identical kind of one-line, same-DTO
// gap, not a separate, unrelated change.
export const loyaltyTransactionSchema = z.object({
  id: z.uuid(),
  loyaltyAccountId: z.uuid(),
  type: z.enum(['checkin', 'purchase', 'redemption', 'referral_bonus', 'birthday_bonus', 'adjustment']),
  points: z.number(),
  relatedRewardId: z.uuid().nullable(),
  visitSessionId: z.uuid().nullable(),
  feedbackId: z.uuid().nullable(),
  purchaseAmount: z.string().nullable(),
  redemptionCode: z.string().nullable(),
  redemptionConfirmedAt: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});

export const loyaltySettingsSchema = z.object({
  businessId: z.uuid(),
  pointsPerCheckin: z.number(),
  pointsPerCurrencyUnit: z.number(),
  referralBonusPoints: z.number(),
  birthdayBonusPoints: z.number(),
});

export const redemptionResultSchema = z.object({
  redemptionCode: z.string(),
  pointsSpent: z.number(),
  remainingBalance: z.number(),
});

/** Continuing Development Block 2 -- response DTO for the new POST
 * /loyalty/me/accounts/:businessId/issue route. Mirrors
 * LoyaltyRedemptionService's own IssuanceResult interface exactly (same
 * independently-defined, shape-compatible relationship
 * redemptionResultSchema/RedemptionResult already have with redeem() above,
 * not one importing the other -- see CampaignDashboardDto's own comment
 * further up for why this file follows that pattern). `type` uses
 * rewardTypeSchema rather than a bare z.string() -- strictly more precise
 * than the service's own `type: string` field, matching loyaltyRewardSchema.
 * type's identical choice above; additive precision, not a behavior change. */
export const issuanceResultSchema = z.object({
  redemptionCode: z.string(),
  reward: z.object({
    id: z.uuid(),
    name: z.string(),
    type: rewardTypeSchema,
  }),
});

export type RecordPurchaseInput = z.infer<typeof recordPurchaseSchema>;
export type AdjustPointsInput = z.infer<typeof adjustPointsSchema>;
export type CreateTierInput = z.infer<typeof createTierSchema>;
export type UpdateTierInput = z.infer<typeof updateTierSchema>;
export type CreateRewardInput = z.infer<typeof createRewardSchema>;
export type UpdateRewardInput = z.infer<typeof updateRewardSchema>;
export type UpdateLoyaltySettingsInput = z.infer<typeof updateLoyaltySettingsSchema>;
export type JoinLoyaltyProgramInput = z.infer<typeof joinLoyaltyProgramSchema>;
export type CheckinInput = z.infer<typeof checkinSchema>;
export type RedeemRewardInput = z.infer<typeof redeemRewardSchema>;
export type IssueRewardInput = z.infer<typeof issueRewardSchema>;
export type LoyaltyTierDto = z.infer<typeof loyaltyTierSchema>;
export type LoyaltyRewardDto = z.infer<typeof loyaltyRewardSchema>;
export type CampaignDashboardDto = z.infer<typeof campaignDashboardSchema>;
export type LoyaltyAccountDto = z.infer<typeof loyaltyAccountSchema>;
export type LoyaltyAccountWithCustomerDto = z.infer<typeof loyaltyAccountWithCustomerSchema>;
export type LoyaltyTransactionDto = z.infer<typeof loyaltyTransactionSchema>;
export type LoyaltySettingsDto = z.infer<typeof loyaltySettingsSchema>;
export type RedemptionResult = z.infer<typeof redemptionResultSchema>;
export type IssuanceResultDto = z.infer<typeof issuanceResultSchema>;
