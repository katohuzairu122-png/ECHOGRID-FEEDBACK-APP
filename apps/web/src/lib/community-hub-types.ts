import type {
  CommunityMembershipStatus,
  CommunityPointAccountStatus,
  CommunityPointTransactionSource,
  CommunityPointTransactionType,
} from '@echo-grid-feedback/shared-types';

/**
 * Shapes of the three EXISTING customer-authenticated read endpoints behind the Community hub
 * (apps/api/src/community/*-customer.routes.ts). Mirrored here read-only; no endpoint was added.
 * GET /community/me                       -> { membership | null, account | null }
 * GET /community-points/me                -> { account | null }
 * GET /community-points/me/transactions   -> { transactions, pagination }
 */
export interface CommunityMembershipDto {
  id: string;
  customerId: string;
  status: CommunityMembershipStatus;
  policyVersion: string;
  joinedAt: string;
  leftAt: string | null;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityPointAccountDto {
  id: string;
  status: CommunityPointAccountStatus;
  pointsBalance: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityTransactionDto {
  id: string;
  type: CommunityPointTransactionType;
  points: number;
  sourceType: CommunityPointTransactionSource;
  businessId: string | null;
  branchId: string | null;
  reversalOf: string | null;
  createdAt: string;
}

export interface CommunityStatusResponse {
  membership: CommunityMembershipDto | null;
  account: (CommunityPointAccountDto & { customerId?: string }) | null;
}
export interface CommunityPointsResponse {
  account: CommunityPointAccountDto | null;
}
export interface CommunityTransactionsResponse {
  transactions: CommunityTransactionDto[];
  pagination: { limit: number; offset: number; returned: number };
}

/** A section either has real data or says honestly why it does not; it is never a fabricated zero. */
export type HubSection<T> = { status: 'ready'; data: T } | { status: 'forbidden' | 'unavailable' };

export interface CommunityHubData {
  membership: HubSection<CommunityStatusResponse>;
  points: HubSection<CommunityPointsResponse>;
  transactions: HubSection<{
    items: CommunityTransactionDto[];
    limit: number;
    offset: number;
    hasMore: boolean;
  }>;
  /** Business display names resolved from the public business endpoint; ids that fail are simply absent. */
  businessNames: Record<string, string>;
}
