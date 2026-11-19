import { getTranslations } from 'next-intl/server';
import { CashierShell } from '@/components/cashier/cashier-shell';
import { InvitePanel } from '@/components/cashier/invite-panel';
import { getCashierContext } from '@/lib/cashier/session';

/** Invite a customer (CASHIER-AUTH-02D): one-time onboarding invitation for this session's branch. */
async function InviteScreen() {
  const ctx = await getCashierContext();
  if (!ctx) return null;
  const t = await getTranslations('cashier.invite');
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">{t('title')}</h1>
      </header>
      {/* Keyed by branch: switching branch discards any invitation shown; the action is bound to the branch this screen was drawn for. */}
      <InvitePanel
        key={ctx.branchId ?? 'business'}
        expectedBranchId={ctx.branchId}
        branchName={ctx.branchName}
        copy={{
          intro: t('intro'), create: t('create'), creating: t('creating'), another: t('another'), qrLabel: t('qrLabel'), scanHint: t('scanHint'),
          validFor: t('validFor', { time: '{time}' }), expiredTitle: t('expiredTitle'), expiredBody: t('expiredBody'), copy: t('copy'),
          copied: t('copied'), copyFailed: t('copyFailed'), rateLimited: t('rateLimited'), branchRequired: t('branchRequired'),
          unavailable: t('unavailable'),
        }}
      />
    </section>
  );
}

export default function CashierInvitePage() {
  return (
    <CashierShell>
      <InviteScreen />
    </CashierShell>
  );
}
