import { getTranslations } from 'next-intl/server';
import { RedeemLookupForm } from '@/app/dashboard/loyalty/redeem/redeem-lookup-form';
import { cashierConfirmRedemptionAction, cashierLookupRedemptionAction } from '@/lib/cashier/actions';

export default async function CashierRedeemPage() {
  const t = await getTranslations('cashier.redeem');
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <p className="text-sm text-neutral-600">{t('subtitle')}</p>
      </header>
      <RedeemLookupForm
        lookupAction={cashierLookupRedemptionAction}
        confirmAction={cashierConfirmRedemptionAction}
      />
    </section>
  );
}
