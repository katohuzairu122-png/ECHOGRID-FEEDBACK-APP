import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui';
import { hasCustomerSession } from '@/lib/customer-session';
import { customerLogoutAction } from '@/lib/actions/customer-auth';
import { getCustomerDeletionStatus, isCustomerDeletionWebEnabled } from '@/lib/actions/customer-deletion';
import { CustomerDeletionRestoreForm } from './restore-form';

export const dynamic = 'force-dynamic';

export default async function CustomerDeletionPendingPage() {
  if (!isCustomerDeletionWebEnabled()) redirect('/loyalty/dashboard');
  if (!(await hasCustomerSession())) redirect('/loyalty/login?next=%2Floyalty%2Fdeletion%2Fpending');
  const status = await getCustomerDeletionStatus();
  if (status.status !== 'pending') redirect('/loyalty/dashboard');
  const t = await getTranslations('loyalty.customer.accountDeletion');
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-5 p-6">
      <h1 className="text-2xl font-semibold">{t('pendingTitle')}</h1>
      <p>{t('pendingDescription', { date: new Date(status.scheduledFor).toLocaleDateString('en-GB') })}</p>
      <p className="text-sm text-neutral-700">{t('operatorNotice')}</p>
      <CustomerDeletionRestoreForm />
      <form action={customerLogoutAction}>
        <Button variant="outline" type="submit">{t('signOut')}</Button>
      </form>
    </main>
  );
}
