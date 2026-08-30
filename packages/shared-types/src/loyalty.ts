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

export const adjustPointsSchema = z.object({
  points: z.number().int().refine((v) => v !== 0, { error: 'Adjustment cannot be zero.' }),
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
  branchId: z.uuid().optional(),
  type: rewardTypeSchema.optional(),
  rewardValue: z.number().positive().max(1_000_000).optional(),
  startDate: z.iso.datetime().optional(),
  expiryDate: z.iso.datetime().optional(),
  maxRewardsPerDay: z.number().int().positive().optional(),
  maxBudget: z.number().positive().max(1_000_000).optional(),
  limitPer: rewardLimitPerSchema.optional(),
  limitPeriodDays: z.number().int().positive().optional(),
  cooldownSeconds: z.number().int().min(0).optional(),
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

export const redeemRewardSchema = z.object({
  rewardId: z.uuid(),
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

export const loyaltyTransactionSchema = z.object({
  id: z.uuid(),
  loyaltyAccountId: z.uuid(),
  type: z.enum(['checkin', 'purchase', 'redemption', 'referral_bonus', 'birthday_bonus', 'adjustment']),
  points: z.number(),
  relatedRewardId: z.uuid().nullable(),
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
export type LoyaltyTierDto = z.infer<typeof loyaltyTierSchema>;
export type LoyaltyRewardDto = z.infer<typeof loyaltyRewardSchema>;
export type CampaignDashboardDto = z.infer<typeof campaignDashboardSchema>;
export type LoyaltyAccountDto = z.infer<typeof loyaltyAccountSchema>;
export type LoyaltyAccountWithCustomerDto = z.infer<typeof loyaltyAccountWithCustomerSchema>;
export type LoyaltyTransactionDto = z.infer<typeof loyaltyTransactionSchema>;
export type LoyaltySettingsDto = z.infer<typeof loyaltySettingsSchema>;
export type RedemptionResult = z.infer<typeof redemptionResultSchema>;
