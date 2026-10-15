import Link from 'next/link';
import { customerApiFetch } from '@/lib/customer-api-client';
import type { OrphanClaimView } from '@/lib/settlement-types';
import { SettlementAccessForm } from './settlement-access-form';

export default async function CustomerSettlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string; businessQrToken?: string }>;
}) {
  const query = await searchParams;
  const offset = Math.max(0, Number(query.offset) || 0);
  const { claims, pagination } = await customerApiFetch<{
    claims: OrphanClaimView[];
    pagination: { returned: number };
  }>(`/orphan-claims/me?limit=20&offset=${offset}`, { cache: 'no-store' });
  const requests = await customerApiFetch<{
    settlements: { id: string; status: string; receivingBusinessId: string }[];
    pagination: { returned: number };
  }>(`/orphan-settlements?limit=20&offset=${offset}`, { cache: 'no-store' });
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">Orphan reward settlement</h1>
      <p>
        Only eligible issued rewards can be settled. This does not transfer a loyalty balance, grant
        Community Points or issue Partner Credits.
      </p>
      {claims.length === 0 && <p>No orphan reward claims on this page.</p>}
      {claims.map((claim) => (
        <article key={claim.id} className="space-y-3 rounded-xl border bg-white p-5">
          <h2 className="font-semibold">
            {claim.sourceRewardSnapshot.rewardName ?? claim.sourceRewardType}
          </h2>
          <p>{claim.sourceRewardSnapshot.description}</p>
          <p>Status: {claim.status}</p>
          {claim.status === 'available' && (
            <SettlementAccessForm claimId={claim.id} initialQrToken={query.businessQrToken ?? ''} />
          )}
        </article>
      ))}
      <nav aria-label="Claim pages" className="flex gap-4">
        {offset > 0 && (
          <Link href={`/loyalty/dashboard/settlements?offset=${Math.max(0, offset - 20)}`}>
            Previous
          </Link>
        )}
        {(pagination.returned === 20 || requests.pagination.returned === 20) && (
          <Link href={`/loyalty/dashboard/settlements?offset=${offset + 20}`}>Next</Link>
        )}
      </nav>
      <h2 className="text-xl font-semibold">My settlement requests</h2>
      {requests.settlements.map((request) => (
        <Link
          key={request.id}
          href={`/loyalty/dashboard/settlements/${request.id}`}
          className="block break-all rounded border bg-white p-4"
        >
          {request.id} · {request.status}
        </Link>
      ))}
    </section>
  );
}
