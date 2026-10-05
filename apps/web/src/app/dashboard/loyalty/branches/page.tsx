import type { BranchDto, BranchProgramDto } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { LoyaltySubnav } from '../loyalty-subnav';
import { BranchProgramForm, BranchStaffTransactionForm } from './branch-program-form';
export const dynamic = 'force-dynamic';
export default async function BranchProgramsPage() {
  const business = await getActiveBusiness();
  if (!business) return <p>Select a business first.</p>;
  const branches = await apiFetch<BranchDto[]>('/branches', { businessId: business.id });
  const programs = await Promise.all(
    branches.map((branch) =>
      apiFetch<BranchProgramDto | null>(`/branch-loyalty/staff/branches/${branch.id}/program`, {
        businessId: business.id,
        branchId: branch.id,
      }),
    ),
  );
  return (
    <div className="space-y-6">
      <LoyaltySubnav />
      <h1 className="text-2xl font-semibold">Branch purchase loyalty</h1>
      <p>
        Each branch has its own memberships, progress and redemption. Both onboarding modes use your
        business subscription.
      </p>
      {branches.map((branch, index) => (
        <section key={branch.id} className="space-y-5 rounded-xl border bg-white p-5">
          <h2 className="text-xl font-semibold">{branch.name}</h2>
          <details>
            <summary>Configure branch program</summary>
            <BranchProgramForm branchId={branch.id} program={programs[index] ?? null} />
          </details>
          <details>
            <summary>Confirm qualifying purchase</summary>
            <BranchStaffTransactionForm branchId={branch.id} operation="purchase" />
          </details>
          <details>
            <summary>Fulfill branch reward</summary>
            <BranchStaffTransactionForm branchId={branch.id} operation="confirm" />
          </details>
          <details>
            <summary>Refund and cancel reward units</summary>
            <BranchStaffTransactionForm branchId={branch.id} operation="refund" />
          </details>
        </section>
      ))}
    </div>
  );
}
