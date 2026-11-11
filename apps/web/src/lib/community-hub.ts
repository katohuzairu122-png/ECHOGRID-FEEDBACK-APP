import 'server-only';
import type { BusinessPublicDto } from '@echo-grid-feedback/shared-types';
import { ApiError } from './api-error';
import { customerApiFetch } from './customer-api-client';
import { publicApiFetch } from './public-api-client';
import { rethrowControlFlow } from './rethrow-control-flow';
import type {
  CommunityHubData,
  CommunityStatusResponse,
  CommunityTransactionsResponse,
  HubSection,
} from './community-hub-types';

export const COMMUNITY_PAGE_SIZE = 20;

/**
 * One read. customerApiFetch redirects to the customer login on a 401 (control flow, re-thrown here);
 * a 403 is reported as `forbidden`, anything else as `unavailable`. A failure is never turned into zero data.
 */
async function read<T>(path: string): Promise<HubSection<T>> {
  try {
    return { status: 'ready', data: await customerApiFetch<T>(path, { cache: 'no-store' }) };
  } catch (error) {
    rethrowControlFlow(error);
    return {
      status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unavailable',
    };
  }
}

/**
 * Read-only data for the customer Community hub. Uses ONLY existing customer-authenticated GET endpoints:
 * GET /community/me (membership + points account) and GET /community-points/me/transactions (ledger).
 * `offset` pages the Community Points ledger with the API's own limit/offset parameters.
 */
export async function getCommunityHub(offset = 0): Promise<CommunityHubData> {
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const [membership, ledger] = await Promise.all([
    read<CommunityStatusResponse>('/community/me'),
    read<CommunityTransactionsResponse>(
      `/community-points/me/transactions?limit=${COMMUNITY_PAGE_SIZE}&offset=${safeOffset}`,
    ),
  ]);

  // GET /community/me returns the membership AND the same points-account row that GET /community-points/me
  // serves (both call communityPointAccounts.findByCustomerId). Reading the account from the one response
  // avoids a redundant request against the customer rate limit (20 requests/minute).
  const points: CommunityHubData['points'] =
    membership.status === 'ready'
      ? { status: 'ready', data: { account: membership.data.account } }
      : { status: membership.status };

  const transactions: CommunityHubData['transactions'] =
    ledger.status === 'ready'
      ? {
          status: 'ready',
          data: {
            items: ledger.data.transactions,
            limit: COMMUNITY_PAGE_SIZE,
            offset: safeOffset,
            // The API has no total count: a full page means there may be older entries.
            hasMore: ledger.data.transactions.length >= COMMUNITY_PAGE_SIZE,
          },
        }
      : { status: ledger.status };

  const businessNames: Record<string, string> = {};
  if (ledger.status === 'ready') {
    const ids = [
      ...new Set(
        ledger.data.transactions.map((t) => t.businessId).filter((id): id is string => !!id),
      ),
    ];
    const settled = await Promise.allSettled(
      ids.map((id) => publicApiFetch<BusinessPublicDto>(`/businesses/${id}/public`)),
    );
    settled.forEach((result, index) => {
      const id = ids[index];
      if (id && result.status === 'fulfilled' && result.value.name)
        businessNames[id] = result.value.name;
    });
  }

  return { membership, points, transactions, businessNames };
}
