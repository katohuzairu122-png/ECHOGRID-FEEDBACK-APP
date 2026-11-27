'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { StaffCustomerCardDto } from '@/lib/actions/unified-qr';

/**
 * What the cashier sees right after scanning a member: the card at THIS business (name, points, tier, visits) and which of this
 * business's rewards the balance already covers. Read-only; redeeming still goes through the confirmed actions below it.
 */
export function CustomerCard({ card }: { card: StaffCustomerCardDto }) {
  const t = useTranslations('loyalty.staff.serve.card');
  const format = useFormatter();
  return (
    <section aria-label={t('title')} className="space-y-4 rounded-xl border bg-white p-5" data-testid="customer-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{t('title')}</p>
          <p className="truncate text-lg font-semibold text-neutral-900">{card.displayName}</p>
        </div>
        {card.tier ? (
          <span className="shrink-0 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-800">{card.tier.name}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-lg bg-neutral-50 p-3">
          <p className="text-2xl font-bold text-neutral-900" data-testid="card-points">{format.number(card.points)}</p>
          <p className="text-xs text-neutral-500">{t('points')}</p>
        </div>
        <div className="rounded-lg bg-neutral-50 p-3">
          <p className="text-2xl font-bold text-neutral-900">{format.number(card.visitCount)}</p>
          <p className="text-xs text-neutral-500">{t('visits')}</p>
        </div>
      </div>
      {card.lastVisitAt ? (
        <p className="text-xs text-neutral-500">
          {t('lastVisit', { date: format.dateTime(new Date(card.lastVisitAt), { dateStyle: 'medium' }) })}
        </p>
      ) : null}
      <div>
        <h3 className="text-sm font-semibold text-neutral-900">{t('rewardsTitle')}</h3>
        {card.rewards.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-600">{t('noRewards')}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {card.rewards.map((reward) => (
              <li
                key={reward.id}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                data-testid={`card-reward-${reward.enoughPoints ? 'ready' : 'locked'}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-900">{reward.name}</p>
                  <p className="text-xs text-neutral-500">{t('cost', { count: format.number(reward.pointsCost) })}</p>
                </div>
                <span
                  className={
                    reward.enoughPoints
                      ? 'shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800'
                      : 'shrink-0 rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600'
                  }
                >
                  {reward.enoughPoints ? t('ready') : t('needMore', { count: format.number(reward.pointsNeeded) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Shown instead of the card when the scanned customer has no active membership at this business. */
export function NotAMemberNotice() {
  const t = useTranslations('loyalty.staff.serve.card');
  return (
    <section className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-5" data-testid="not-a-member">
      <p className="font-semibold text-amber-900">{t('notMemberTitle')}</p>
      <p className="text-sm text-amber-900">{t('notMemberBody')}</p>
    </section>
  );
}
