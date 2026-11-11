import { getActiveBusiness } from '@/lib/business';
import { StaffQrMenu } from './staff-qr-menu';
import { apiFetch } from '@/lib/api-client';
import { getTranslations } from 'next-intl/server';
import { getCurrentUser } from '@/lib/platform';

export default async function StaffQrPage() {
  const business = await getActiveBusiness();
  if (!business) return <p>Select a business to continue.</p>;
  const t = await getTranslations('loyalty.staff.serve');
  const user = await getCurrentUser();
  const contexts = await apiFetch<{ branchId: string | null; branchName: string | null }[]>(
    `/businesses/${business.id}/action-contexts`,
    { cache: 'no-store' },
  );
  return (
    <section className="mx-auto max-w-2xl space-y-5 px-4 py-8">
      <header className="space-y-1 text-center">
        <p className="text-sm text-neutral-500">{t('loggedInAs')}</p>
        <h1 className="text-3xl font-bold">{business.name}</h1>
        {user && <p className="text-sm text-neutral-600">{user.fullName}</p>}
        <p className="pt-2 text-sm text-neutral-600">{t('scanHint')}</p>
        <p className="sr-only">{t('title')}. {t('subtitle')}</p>
      </header>
      <StaffQrMenu contexts={contexts} />
    </section>
  );
}
