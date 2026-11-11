import { getActiveBusiness } from '@/lib/business';
import { StaffQrMenu } from './staff-qr-menu';
import { apiFetch } from '@/lib/api-client';
import { getTranslations } from 'next-intl/server';

export default async function StaffQrPage() {
  const business = await getActiveBusiness();
  if (!business) return <p>Select a business to continue.</p>;
  const t = await getTranslations('loyalty.staff.serve');
  const contexts = await apiFetch<{ branchId: string | null; branchName: string | null }[]>(
    `/businesses/${business.id}/action-contexts`,
    { cache: 'no-store' },
  );
  return (
    <section className="mx-auto max-w-2xl space-y-5 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-neutral-500">{business.name}</p>
      <p>{t('subtitle')}</p>
      <StaffQrMenu contexts={contexts} />
    </section>
  );
}
