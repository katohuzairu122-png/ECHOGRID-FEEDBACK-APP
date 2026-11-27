/** LPC-10 DTOs: what the purchase-history and reversal endpoints return (dates arrive as ISO strings). */
export interface PurchaseDto {
  id: string;
  accountId: string;
  customerName: string | null;
  occurredAt: string;
  channel: string;
  /** Exact decimal text as stored; shown as received, never converted to a floating-point number. */
  amount: string;
  status: 'confirmed' | 'refunded' | 'reversed';
  pointsEarned: number;
  reversal: { reversedAt: string; pointsReversed: number; pointsShortfall: number } | null;
}
export interface PurchaseListDto {
  items: PurchaseDto[];
  hasMore: boolean;
}
export interface RewardImpactDto {
  rewardName: string;
  outcome: 'revoked' | 'already_used';
}
export interface ReversalPreviewDto {
  purchaseEventId: string;
  pointsEarned: number;
  pointsReversed: number;
  pointsShortfall: number;
  rewardImpact: RewardImpactDto[];
  frozenProgrammes: number;
  needsReview: boolean;
}
export interface ReversalResultDto extends Omit<ReversalPreviewDto, 'pointsEarned' | 'frozenProgrammes'> {
  revokedRewards: number;
  rewardsAlreadyUsed: number;
}
