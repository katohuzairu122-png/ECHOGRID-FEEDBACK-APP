export interface OrphanClaimView {
  id: string;
  originBusinessId: string;
  status: string;
  sourceRewardType: string;
  sourceRewardSnapshot: { rewardName?: string; description?: string };
}
export interface SettlementView {
  id: string;
  claimId: string;
  receivingBusinessId: string;
  receivingBranchId: string | null;
  status: string;
  expiresAt: string;
  fulfillmentPolicyVersion: string | null;
  fulfillmentReference: string | null;
  fulfillmentSnapshot: {
    benefitType?: string;
    title?: string;
    description?: string;
    terms?: string | null;
  } | null;
}
export interface SettlementAccessView {
  settlementId: string;
  authorizationExpiresAt: string;
  claim: {
    sourceRewardType: string;
    reward: {
      name: string | null;
      description: string | null;
      value: string | null;
      expiryDate: string | null;
    };
  };
}
