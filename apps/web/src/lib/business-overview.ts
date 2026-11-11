import 'server-only';
import { redirect } from 'next/navigation';
import type {
  FeedbackDto,
  LoyaltyAccountWithCustomerDto,
  SentimentTrendPointDto,
  BranchDto,
} from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from './api-client';

export type OverviewResult<T> =
  { status: 'ready'; data: T } | { status: 'forbidden' | 'unavailable' };
export interface FeedbackPreview {
  items: FeedbackDto[];
  hasMore: boolean;
}

/** Every read carries the server-resolved business ID. Denials never become zero KPIs. */
async function read<T>(path: string, businessId: string): Promise<OverviewResult<T>> {
  try {
    return { status: 'ready', data: await apiFetch<T>(path, { businessId, cache: 'no-store' }) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/login');
    return {
      status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unavailable',
    };
  }
}

/**
 * `branchId` narrows ONLY the reads the API genuinely branch-scopes (sentiment trend and the two feedback
 * previews; the API re-authorizes it server-side). Loyalty accounts and the branch list stay business-wide.
 * The id is checked against the caller's own branch list first; an id that is not in it is reported as
 * `branchFilter.status = 'invalid'` and the page shows all branches, never a silently different scope.
 */
export async function getBusinessOverview(businessId: string, branchId?: string) {
  if (!businessId) throw new Error('Business scope is required');
  const scoped = (path: string, id?: string) =>
    id ? path + (path.includes('?') ? '&' : '?') + 'branchId=' + encodeURIComponent(id) : path;
  const read5 = (id?: string, preloaded?: OverviewResult<BranchDto[]>) =>
    Promise.all([
      read<SentimentTrendPointDto[]>(scoped('/analytics/trends', id), businessId),
      read<FeedbackPreview>(scoped('/feedback?limit=5&offset=0', id), businessId),
      read<FeedbackPreview>(
        scoped('/feedback?limit=5&offset=0&savedView=high_priority_unresolved', id),
        businessId,
      ),
      read<LoyaltyAccountWithCustomerDto[]>('/loyalty/accounts?limit=5', businessId),
      preloaded ?? read<BranchDto[]>('/branches', businessId),
    ]);
  if (!branchId) {
    const [trend, feedback, priority, loyalty, branches] = await read5();
    return {
      trend,
      feedback,
      priority,
      loyalty,
      branches,
      branchFilter: { status: 'none' as const },
    };
  }
  const branches = await read<BranchDto[]>('/branches', businessId);
  const match =
    branches.status === 'ready' ? branches.data.find((b) => b.id === branchId) : undefined;
  const effective = match?.id;
  const [trend, feedback, priority, loyalty] = await read5(effective, branches);
  return {
    trend,
    feedback,
    priority,
    loyalty,
    branches,
    branchFilter: match
      ? { status: 'active' as const, branchId: match.id }
      : { status: 'invalid' as const },
  };
}

export function trendTotals(points: SentimentTrendPointDto[]) {
  const sum = (key: 'positive' | 'neutral' | 'negative') =>
    points.reduce((acc, point) => acc + point[key], 0);
  const positive = sum('positive');
  const neutral = sum('neutral');
  const negative = sum('negative');
  const total = positive + neutral + negative;
  return {
    total,
    positive,
    neutral,
    negative,
    positiveRate: total === 0 ? null : positive / total,
    negativeRate: total === 0 ? null : negative / total,
  };
}
