import { z } from 'zod';

export const communityMembershipStatusSchema = z.enum(['active', 'left', 'suspended']);
export type CommunityMembershipStatus = z.infer<typeof communityMembershipStatusSchema>;

export const communityPointAccountStatusSchema = z.enum(['active', 'suspended', 'closed']);
export type CommunityPointAccountStatus = z.infer<typeof communityPointAccountStatusSchema>;

export const communityPointRuleStatusSchema = z.enum(['draft', 'active', 'paused', 'retired']);
export type CommunityPointRuleStatus = z.infer<typeof communityPointRuleStatusSchema>;

export const communityPointEarningSourceSchema = z.enum(['survey_completion']);
export type CommunityPointEarningSource = z.infer<typeof communityPointEarningSourceSchema>;

export const communityPointRuleResourceTypeSchema = z.enum(['survey_campaign']);
export type CommunityPointRuleResourceType = z.infer<typeof communityPointRuleResourceTypeSchema>;

export const communityPointAwardDecisionStatusSchema = z.enum([
  'pending_membership',
  'awarded',
  'rejected',
  'reversed',
]);
export type CommunityPointAwardDecisionStatus = z.infer<
  typeof communityPointAwardDecisionStatusSchema
>;

export const communityPointTransactionTypeSchema = z.enum([
  'earn',
  'redeem',
  'reverse',
  'expire',
  'admin_adjustment',
]);
export type CommunityPointTransactionType = z.infer<
  typeof communityPointTransactionTypeSchema
>;

export const communityPointTransactionSourceSchema = z.enum([
  'survey_completion',
  'redemption',
  'reversal',
  'expiration',
  'admin_adjustment',
]);
export type CommunityPointTransactionSource = z.infer<
  typeof communityPointTransactionSourceSchema
>;


export const communityPointLedgerQuerySchema = z.object({
  customerId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  businessId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  type: communityPointTransactionTypeSchema.optional(),
  sourceType: communityPointTransactionSourceSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type CommunityPointLedgerQuery = z.infer<
  typeof communityPointLedgerQuerySchema
>;

export const joinCommunitySchema = z.object({
  policyVersion: z.string().trim().min(1).max(100),
});
export type JoinCommunityInput = z.infer<typeof joinCommunitySchema>;

export const createCommunityPointRuleSchema = z
  .object({
    sourceType: communityPointEarningSourceSchema,
    resourceType: communityPointRuleResourceTypeSchema.optional(),
    resourceId: z.uuid().optional(),
    points: z.number().int().positive().max(1_000_000),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
  })
  .superRefine((rule, ctx) => {
    if ((rule.resourceType === undefined) !== (rule.resourceId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['resourceId'],
        message: 'resourceType and resourceId must be provided together.',
      });
    }
    if (
      rule.startsAt &&
      rule.endsAt &&
      new Date(rule.endsAt) <= new Date(rule.startsAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'endsAt must be later than startsAt.',
      });
    }
  });
export type CreateCommunityPointRuleInput = z.infer<
  typeof createCommunityPointRuleSchema
>;

export const communityPointAdminAdjustmentSchema = z.object({
  points: z.number().int().refine((value) => value !== 0, {
    message: 'Adjustment points must not be zero.',
  }),
  reason: z.string().trim().min(3).max(1000),
  idempotencyKey: z.string().trim().min(8).max(200),
});
export type CommunityPointAdminAdjustmentInput = z.infer<
  typeof communityPointAdminAdjustmentSchema
>;

export const communityMembershipSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  status: communityMembershipStatusSchema,
  policyVersion: z.string(),
  joinedAt: z.string(),
  leftAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommunityMembershipDto = z.infer<typeof communityMembershipSchema>;

export const communityPointAccountSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  status: communityPointAccountStatusSchema,
  pointsBalance: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommunityPointAccountDto = z.infer<typeof communityPointAccountSchema>;

export const communityPointRuleSchema = z.object({
  id: z.uuid(),
  sourceType: communityPointEarningSourceSchema,
  resourceType: communityPointRuleResourceTypeSchema.nullable(),
  resourceId: z.uuid().nullable(),
  version: z.number().int().positive(),
  status: communityPointRuleStatusSchema,
  points: z.number().int().positive(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
});
export type CommunityPointRuleDto = z.infer<typeof communityPointRuleSchema>;

export const communityPointAwardDecisionSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  accountId: z.uuid().nullable(),
  sourceType: communityPointEarningSourceSchema,
  sourceRef: z.string().min(1),
  ruleId: z.uuid(),
  status: communityPointAwardDecisionStatusSchema,
  points: z.number().int().positive(),
  reasonCode: z.string().nullable(),
  evaluatedAt: z.string(),
  awardedTransactionId: z.uuid().nullable(),
  createdAt: z.string(),
});
export type CommunityPointAwardDecisionDto = z.infer<
  typeof communityPointAwardDecisionSchema
>;

export const communityPointTransactionSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  customerId: z.uuid(),
  type: communityPointTransactionTypeSchema,
  points: z.number().int().refine((value) => value !== 0),
  sourceType: communityPointTransactionSourceSchema,
  sourceRef: z.string().nullable(),
  ruleId: z.uuid().nullable(),
  awardDecisionId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
  branchId: z.uuid().nullable(),
  reversalOf: z.uuid().nullable(),
  idempotencyKey: z.string(),
  createdAt: z.string(),
});
export type CommunityPointTransactionDto = z.infer<
  typeof communityPointTransactionSchema
>;
