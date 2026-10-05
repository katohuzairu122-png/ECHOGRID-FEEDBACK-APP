import Link from 'next/link';
import type { BranchMembershipDto, BranchLedgerDto } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { CommunityChoiceForm, MembershipQr, RedeemBranchForm } from '../../branch-panel';
export const dynamic = 'force-dynamic';
export default async function BranchRewardsPage() {
  const [accounts, choice] = await Promise.all([
    customerApiFetch<BranchMembershipDto[]>('/branch-loyalty/me/memberships'),
    customerApiFetch<{ joined: boolean }>('/branch-loyalty/me/community'),
  ]);
  const histories = await Promise.all(
    accounts.map((a) =>
      customerApiFetch<BranchLedgerDto[]>(`/branch-loyalty/me/memberships/${a.id}/history`),
    ),
  );
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">My branch rewards</h1>
      <CommunityChoiceForm joined={choice.joined} />
      {choice.joined && (
        <Link className="block underline" href="/community">
          Discover member businesses
        </Link>
      )}
      {!accounts.length && (
        <p>
          Scan a branch QR to start enrollment. Your first qualifying paid purchase activates
          membership.
        </p>
      )}
      {accounts.map((a, index) => (
        <section key={a.id} className="space-y-3 rounded-xl border bg-white p-5">
          <h2 className="text-xl font-semibold">
            {a.businessName} · {a.branchName}
          </h2>
          <p>
            {a.activatedAt
              ? 'Active membership · verified purchase'
              : 'Awaiting first qualifying purchase'}
          </p>
          <p>
            {a.units} {a.unitLabel} · {a.rewardCost} unlocks {a.rewardName}
          </p>
          <p>Earned and redeemed at this branch.</p>
          <MembershipQr id={a.id} />
          <RedeemBranchForm
            id={a.id}
            requestId={crypto.randomUUID()}
            disabled={!a.enabled || !a.activatedAt || a.units < a.rewardCost}
          />
          <details>
            <summary>Purchase and reward history</summary>
            <ul className="space-y-2">
              {histories[index]?.map((entry) => (
                <li key={entry.id} className="break-all text-sm">
                  {entry.type}: {entry.units} {a.unitLabel} ·{' '}
                  {new Date(entry.createdAt).toLocaleDateString('en-GB')}
                  {entry.receiptReference && ` · Receipt ${entry.receiptReference}`}
                  {entry.code &&
                    ` · ${entry.confirmedAt ? 'Fulfilled' : 'Show staff to collect'}: ${entry.code}`}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ))}
      <Link className="block underline" href="/loyalty/dashboard">
        Existing business rewards
      </Link>
    </div>
  );
}
