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

export async function getBusinessOverview(businessId: string) {
  if (!businessId) throw new Error('Business scope is required');
  const [trend, feedback, priority, loyalty, branches] = await Promise.all([
    read<SentimentTrendPointDto[]>('/analytics/trends', businessId),
    read<FeedbackPreview>('/feedback?limit=5&offset=0', businessId),
    read<FeedbackPreview>(
      '/feedback?limit=5&offset=0&savedView=high_priority_unresolved',
      businessId,
    ),
    read<LoyaltyAccountWithCustomerDto[]>('/loyalty/accounts?limit=5', businessId),
    read<BranchDto[]>('/branches', businessId),
  ]);
  return { trend, feedback, priority, loyalty, branches };
}

export function trendTotals(points: SentimentTrendPointDto[]) {
  const total = points.reduce(
    (sum, point) => sum + point.positive + point.neutral + point.negative,
    0,
  );
  const positive = points.reduce((sum, point) => sum + point.positive, 0);
  return { total, positiveRate: total === 0 ? null : positive / total };
}
