import { getCommunityHub } from '@/lib/community-hub';
import { CommunityHubView } from './community-hub-view';

interface CommunityPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Customer Community hub (H1, read-only). Session protection comes from app/loyalty/dashboard/layout.tsx
 * (customer cookie gate) and from customerApiFetch, which redirects to the customer login on a 401.
 * Only existing customer-authenticated GET endpoints are read; nothing here writes.
 */
export default async function CommunityPage({ searchParams }: CommunityPageProps) {
  const raw = (await searchParams).offset;
  const parsed = Number(Array.isArray(raw) ? raw[0] : raw);
  const offset = Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : 0;
  const data = await getCommunityHub(offset);
  return <CommunityHubView data={data} />;
}
