import Link from 'next/link';
import { publicApiFetch } from '@/lib/public-api-client';
export const dynamic = 'force-dynamic';
export default async function CommunityPage() {
  const members = await publicApiFetch<
    {
      businessId: string;
      branchId: string;
      businessName: string;
      branchName: string;
      qualifyingPurchaseDescription: string;
      rewardName: string;
    }[]
  >('/branch-loyalty/public/directory');
  return (
    <main className="mx-auto max-w-3xl space-y-5 p-6">
      <h1 className="text-2xl font-semibold">Echo Grid member businesses</h1>
      <p>
        Visit a branch and scan its QR to join. A qualifying purchase is required for that branch’s
        purchase rewards.
      </p>
      {!members.length && <p>No member branches have been published yet.</p>}
      {members.map((b) => (
        <section className="rounded-xl border p-4" key={b.branchId}>
          <h2 className="font-semibold">
            {b.businessName} · {b.branchName}
          </h2>
          <p>{b.qualifyingPurchaseDescription}</p>
          <p>Reward: {b.rewardName}</p>
        </section>
      ))}
      <Link className="underline" href="/loyalty/dashboard/branches">
        My branch memberships
      </Link>
    </main>
  );
}
