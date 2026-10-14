import { getActiveBusiness } from '@/lib/business';
import { BusinessSettlementForm } from './business-settlement-form';
import { apiFetch } from '@/lib/api-client';
export default async function BusinessSettlementsPage() {
  const business = await getActiveBusiness();
  if (!business) return <p>Select a receiving business.</p>;
  const contexts = await apiFetch<{ branchId: string | null; branchName: string | null }[]>(
    `/businesses/${business.id}/action-contexts`,
    { cache: 'no-store' },
  );
  return (
    <section className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <h1 className="text-2xl font-semibold">Receiving-business orphan settlement</h1>
      <p>
        {business.name}. Customer access consent, your acceptance of a concrete benefit, customer
        completion consent and actual fulfillment are four separate steps.
      </p>
      <p>
        This workflow settles issued orphan rewards. It does not grant loyalty points, redeem an
        ordinary loyalty reward, issue Partner Credits or apply Stripe credits.
      </p>
      <BusinessSettlementForm contexts={contexts} />
    </section>
  );
}
