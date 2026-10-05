import { z } from 'zod';
import { submitFeedbackSchema } from './feedback';

export const branchProgramSchema = z.object({
  onboardingMode: z.enum(['business_only', 'community']),
  listedInCommunity: z.boolean(),
  qualifyingPurchaseDescription: z.string().trim().min(1).max(1000),
  unitLabel: z.string().trim().min(1).max(100),
  rewardName: z.string().trim().min(1).max(200),
  rewardCost: z.number().int().positive().max(1_000_000),
  feedbackBonusUnits: z.number().int().min(0).max(1_000_000),
  enabled: z.boolean(),
});
export const branchJoinSchema = z.object({
  qrToken: z.string().min(1),
  joinCommunity: z.boolean(),
});
export const branchPurchaseSchema = z.object({
  membershipId: z.uuid(),
  receiptReference: z.string().trim().min(1).max(100),
  qualifyingUnits: z.number().int().positive().max(1_000_000),
  evidence: z.string().trim().min(1).max(1000),
});
export const branchRefundSchema = z.object({
  purchaseId: z.uuid(),
  reason: z.string().trim().min(1).max(1000),
});
export const branchRedeemSchema = z.object({ requestId: z.uuid() });
export const branchConfirmSchema = z.object({ code: z.uuid() });
export const communityConsentSchema = z.object({ joined: z.boolean() });
export const branchFeedbackSchema = z.object({
  qrToken: z.string().min(1),
  purchaseId: z.uuid(),
  feedback: submitFeedbackSchema,
});
export type BranchProgramInput = z.infer<typeof branchProgramSchema>;
export type BranchPurchaseInput = z.infer<typeof branchPurchaseSchema>;
export interface BranchMembershipDto {
  id: string;
  businessId: string;
  branchId: string;
  businessName: string;
  branchName: string;
  activatedAt: string | null;
  units: number;
  unitLabel: string;
  rewardName: string;
  rewardCost: number;
  enabled: boolean;
}
export interface BranchProgramDto extends BranchProgramInput {
  businessId: string;
  branchId: string;
}
export interface BranchLedgerDto {
  id: string;
  type: string;
  units: number;
  createdAt: string;
  receiptReference: string | null;
  code: string | null;
  confirmedAt: string | null;
  rewardName: string | null;
}
