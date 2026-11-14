import { getTranslations } from 'next-intl/server';
import { CashierShell } from '@/components/cashier/cashier-shell';
import { getCashierContext } from '@/lib/cashier/session';
import { cashierLogoutAction } from '@/lib/cashier/actions';
import { CashierInstall } from '@/components/cashier/cashier-install';
import { Button } from '@/components/ui';

async function AccountScreen() {
  const ctx = await getCashierContext();
  const t = await getTranslations('cashier.account');
  if (!ctx) return null;
  const row = (label: string, value: string) => (
    <div className="flex justify-between gap-4 py-2">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
  return (
    <section className="space-y-6">
      <h1 className="text-xl font-bold">{t('title')}</h1>
      <dl className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white px-4 text-sm">
        {row(t('business'), ctx.businessName ?? '')}
        {row(t('branch'), ctx.branchName ?? t('branchWide'))}
        {row(t('device'), ctx.deviceLabel ?? t('noDevice'))}
      </dl>
      <div className="space-y-2">
        <h2 className="font-semibold">{t('install.title')}</h2>
        <CashierInstall
          copy={{
            button: t('install.button'),
            installed: t('install.installed'),
            ios: t('install.ios'),
            manual: t('install.manual'),
          }}
        />
      </div>
      <form action={cashierLogoutAction} className="space-y-2">
        <Button type="submit" variant="secondary" className="min-h-12 w-full">
          {t('signOut')}
        </Button>
        <p className="text-sm text-neutral-600">{t('signOutHint')}</p>
      </form>
    </section>
  );
}

export default function CashierAccountPage() {
  return (
    <CashierShell>
      <AccountScreen />
    </CashierShell>
  );
}
