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

export const createRewardSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
  pointsCost: z.number().int().positive(),
});
export const updateRewardSchema = createRewardSchema.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
});

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

export const loyaltyRewardSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  pointsCost: z.number(),
  status: z.enum(['active', 'inactive']),
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
export type LoyaltyAccountDto = z.infer<typeof loyaltyAccountSchema>;
export type LoyaltyAccountWithCustomerDto = z.infer<typeof loyaltyAccountWithCustomerSchema>;
export type LoyaltyTransactionDto = z.infer<typeof loyaltyTransactionSchema>;
export type LoyaltySettingsDto = z.infer<typeof loyaltySettingsSchema>;
export type RedemptionResult = z.infer<typeof redemptionResultSchema>;
