import { getCommunityHub } from '@/lib/community-hub';
import { getLocale } from 'next-intl/server';
import { getCommunityPhoneEligibility, getCommunityTermsOffer } from '@/lib/community-membership';
import { CommunityMembershipControls } from './membership-controls';
import { CommunityHubView } from './community-hub-view';
import { getMyBadges } from '@/lib/tentaship-badges';
import { evaluateMyBadgesAction } from '@/lib/actions/tentaship-badges';
import { BadgesSection } from '@/components/tentaship-badges/badges-section';

interface CommunityPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Customer Community hub. Rendering only reads; membership mutations require an explicit Server Action. Session protection comes from app/loyalty/dashboard/layout.tsx
 * (customer cookie gate) and from customerApiFetch, which redirects to the customer login on a 401.
 * Only existing customer-authenticated GET endpoints are read; nothing here writes.
 */
export default async function CommunityPage({ searchParams }: CommunityPageProps) {
  const raw = (await searchParams).offset;
  const parsed = Number(Array.isArray(raw) ? raw[0] : raw);
  const offset = Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : 0;
  const locale = await getLocale();
  const [data, phone, offer, badges] = await Promise.all([getCommunityHub(offset), getCommunityPhoneEligibility(), getCommunityTermsOffer(locale), getMyBadges()]);
  const controls = data.membership.status === 'ready'
    ? <CommunityMembershipControls status={data.membership.data.membership?.status ?? 'absent'} phone={phone} offer={offer} /> : undefined;
  return (
    <>
      <CommunityHubView data={data} membershipControls={controls} />
      {/* TB-03: only while the independent Tentaship Badges control is open; while closed this renders nothing at all. */}
      {badges.state === 'ready' && <BadgesSection badges={badges.badges} evaluate={evaluateMyBadgesAction} />}
    </>
  );
}
