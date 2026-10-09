import { z } from 'zod';

export const orphanClaimStatusSchema = z.enum([
  'available',
  'reserved',
  'settled',
  'expired',
  'reversed',
  'cancelled',
]);
export type OrphanClaimStatus = z.infer<typeof orphanClaimStatusSchema>;

export const orphanReasonSchema = z.enum([
  'origin_business_archived',
  'platform_unable_to_honor',
]);
export type OrphanReason = z.infer<typeof orphanReasonSchema>;

export const orphanSourceRewardTypeSchema = z.enum([
  'discount',
  'free_item',
  'voucher',
]);
export type OrphanSourceRewardType = z.infer<typeof orphanSourceRewardTypeSchema>;

export const orphanSettlementStatusSchema = z.enum([
  'proposed',
  'accepted',
  'reserved',
  'completion_authorized',
  'fulfilled',
  'cancelled',
  'expired',
  'reversed',
]);
export type OrphanSettlementStatus = z.infer<typeof orphanSettlementStatusSchema>;

export const orphanSettlementEventTypeSchema = z.enum([
  'orphan_created',
  'partner_selected',
  'partner_accepted',
  'settlement_reserved',
  'completion_authorized',
  'settlement_fulfilled',
  'settlement_expired',
  'settlement_cancelled',
  'settlement_reversed',
]);
export type OrphanSettlementEventType = z.infer<
  typeof orphanSettlementEventTypeSchema
>;

export const orphanRewardClaimSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  originBusinessId: z.uuid(),
  originMembershipId: z.uuid().nullable(),
  originLoyaltyAccountId: z.uuid(),
  originLoyaltyTransactionId: z.uuid(),
  originRewardId: z.uuid().nullable(),
  orphanReason: orphanReasonSchema,
  status: orphanClaimStatusSchema,
  sourceRewardType: orphanSourceRewardTypeSchema,
  sourceRewardSnapshot: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  qualifiedAt: z.string(),
  settledAt: z.string().nullable(),
  expiredAt: z.string().nullable(),
  reversedAt: z.string().nullable(),
});
export type OrphanRewardClaimDto = z.infer<typeof orphanRewardClaimSchema>;

export const orphanSettlementSchema = z.object({
  id: z.uuid(),
  claimId: z.uuid(),
  customerId: z.uuid(),
  receivingBusinessId: z.uuid(),
  receivingBranchId: z.uuid().nullable(),
  status: orphanSettlementStatusSchema,
  accessAuthorizationId: z.uuid(),
  acceptedByUserId: z.uuid().nullable(),
  acceptedAt: z.string().nullable(),
  completionAuthorizationId: z.uuid().nullable(),
  completionAuthorizedAt: z.string().nullable(),
  fulfilledByUserId: z.uuid().nullable(),
  fulfilledAt: z.string().nullable(),
  fulfillmentPolicyVersion: z.string().nullable(),
  fulfillmentSnapshot: z.record(z.string(), z.unknown()).nullable(),
  fulfillmentReference: z.string().nullable(),
  expiresAt: z.string(),
  idempotencyKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrphanSettlementDto = z.infer<typeof orphanSettlementSchema>;

export const orphanSettlementEventSchema = z.object({
  id: z.uuid(),
  claimId: z.uuid(),
  settlementId: z.uuid().nullable(),
  customerId: z.uuid(),
  eventType: orphanSettlementEventTypeSchema,
  originBusinessId: z.uuid(),
  receivingBusinessId: z.uuid().nullable(),
  receivingBranchId: z.uuid().nullable(),
  actorUserId: z.uuid().nullable(),
  customerActionAuthorizationId: z.uuid().nullable(),
  idempotencyKey: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type OrphanSettlementEventDto = z.infer<typeof orphanSettlementEventSchema>;


export const orphanSettlementAccessAuthorizationSchema = z.object({
  receivingBusinessId: z.uuid(),
  consentVersion: z.string().trim().min(1).max(100),
  correlationId: z.string().trim().min(8).max(200),
  idempotencyKey: z.string().trim().min(8).max(200),
});
export type OrphanSettlementAccessAuthorizationInput = z.infer<
  typeof orphanSettlementAccessAuthorizationSchema
>;


export const orphanSettlementBusinessAccessSchema = z.object({
  settlementId: z.uuid(),
  authorizationId: z.uuid(),
});
export type OrphanSettlementBusinessAccessInput = z.infer<
  typeof orphanSettlementBusinessAccessSchema
>;

export const orphanSettlementFulfillmentContractSchema = z.object({
  benefitType: z.enum(['discount', 'free_item', 'voucher']),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  terms: z.string().trim().min(1).max(2000).optional(),
  reference: z.string().trim().min(1).max(200).optional(),
});
export type OrphanSettlementFulfillmentContractInput = z.infer<
  typeof orphanSettlementFulfillmentContractSchema
>;

export const orphanSettlementAcceptSchema = z.object({
  authorizationId: z.uuid(),
  fulfillment: orphanSettlementFulfillmentContractSchema,
});
export type OrphanSettlementAcceptInput = z.infer<
  typeof orphanSettlementAcceptSchema
>;


export const orphanSettlementCompletionAuthorizationSchema = z.object({
  correlationId: z.string().trim().min(8).max(200),
  idempotencyKey: z.string().trim().min(8).max(200),
  fulfillmentPolicyVersion: z.string().trim().min(1).max(200),
  fulfillmentReference: z.string().trim().min(1).max(200).nullable(),
});
export type OrphanSettlementCompletionAuthorizationInput = z.infer<
  typeof orphanSettlementCompletionAuthorizationSchema
>;
