import { getActiveBusiness } from '@/lib/business';
import { StaffQrMenu } from './staff-qr-menu';
import { apiFetch } from '@/lib/api-client';

export default async function StaffQrPage() {
  const business = await getActiveBusiness();
  if (!business) return <p>Select a business to continue.</p>;
  const contexts = await apiFetch<{ branchId: string | null; branchName: string | null }[]>(
    `/businesses/${business.id}/action-contexts`,
    { cache: 'no-store' },
  );
  return (
    <section className="mx-auto max-w-2xl space-y-5 px-4 py-8">
      <h1 className="text-2xl font-semibold">Customer QR actions</h1>
      <p>
        {business.name}. Scan with your device and paste the customer’s short-lived QR token.
        Scanning does not grant points or redeem a reward.
      </p>
      <StaffQrMenu contexts={contexts} />
    </section>
  );
}
