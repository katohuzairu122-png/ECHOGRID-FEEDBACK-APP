import { getTranslations } from 'next-intl/server';
import { CashierShell } from '@/components/cashier/cashier-shell';
import { RedeemLookupForm } from '@/app/dashboard/loyalty/redeem/redeem-lookup-form';
import { getCashierContext } from '@/lib/cashier/session';
import { cashierConfirmRedemptionAction, cashierLookupRedemptionAction } from '@/lib/cashier/actions';

async function RedeemScreen() {
  const t = await getTranslations('cashier.redeem');
  const ctx = await getCashierContext();
  const branchId = ctx?.branchId ?? null;
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <p className="text-sm text-neutral-600">{t('subtitle')}</p>
      </header>
      {/* CASHIER-AUTH-02C: keyed by branch, so a branch switch discards any pending lookup or confirmation; the actions are bound to the
          branch this screen was drawn for, so a stale window is redirected instead of acting on the wrong branch. */}
      <RedeemLookupForm
        key={branchId ?? 'business'}
        lookupAction={cashierLookupRedemptionAction.bind(null, branchId)}
        confirmAction={cashierConfirmRedemptionAction.bind(null, branchId)}
      />
    </section>
  );
}

export default function CashierRedeemPage() {
  return (
    <CashierShell>
      <RedeemScreen />
    </CashierShell>
  );
}
