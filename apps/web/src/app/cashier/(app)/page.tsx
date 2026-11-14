import { getTranslations } from 'next-intl/server';
import { getCashierContext } from '@/lib/cashier/session';
import { cashierServeAction } from '@/lib/cashier/actions';
import { StaffQrMenu } from '@/app/dashboard/loyalty/scan/staff-qr-menu';

/** Serve Customers: the cashier app's primary screen. The same lookup, scanning and loyalty servicing as the dashboard, bound to this session's business and branch. */
export default async function CashierServePage() {
  const ctx = await getCashierContext();
  if (!ctx) return null;
  const t = await getTranslations('loyalty.staff.serve');
  return (
    <section className="space-y-4">
      <p className="text-sm text-neutral-600">{t('scanHint')}</p>
      {/* A session is bound to one place, so the branch choice is fixed: one context, nothing to pick or tamper with. */}
      <StaffQrMenu
        contexts={[{ branchId: ctx.branchId, branchName: ctx.branchName }]}
        serveAction={cashierServeAction}
      />
    </section>
  );
}
