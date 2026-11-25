'use client';

import { useActionState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { badgeText, type EarnedBadgeDto } from '@/lib/tentaship-badges-types';
import type { EvaluateBadgesState } from '@/lib/actions/tentaship-badges';
import { Button } from '@/components/ui';

const initial: EvaluateBadgesState = {};

/**
 * TB-03: Tentaship Badges, for a customer or a business. Presentation only. A badge is an achievement: nothing here shows a balance, a value or
 * a way to transfer, redeem or enter anything. The button asks the SERVER to evaluate (it sends nothing). Rendered only when the control is open.
 */
export function BadgesSection({ badges, evaluate }: { badges: EarnedBadgeDto[]; evaluate: (prev: EvaluateBadgesState) => Promise<EvaluateBadgesState> }) {
  const t = useTranslations('common.tentashipBadges');
  const locale = useLocale();
  const format = useFormatter();
  const [state, action, pending] = useActionState(evaluate, initial);
  return (
    <section aria-labelledby="tentaship-badges-title" className="space-y-3 rounded-md border border-neutral-200 bg-white p-4" data-testid="tentaship-badges">
      <h2 id="tentaship-badges-title" className="text-lg font-semibold">{t('title')}</h2>
      <p className="text-sm text-neutral-600">{t('notCurrency')}</p>
      {badges.length === 0 ? (
        <p className="text-sm text-neutral-500">{t('empty')}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {badges.map((b) => (
            <li key={b.awardId} className="rounded-md border border-neutral-200 p-3">
              <p className="font-medium">{badgeText(b.names, locale)}</p>
              {badgeText(b.descriptions, locale) && <p className="text-sm text-neutral-600">{badgeText(b.descriptions, locale)}</p>}
              <p className="text-xs text-neutral-500">{t('earnedOn', { date: format.dateTime(new Date(b.awardedAt), { dateStyle: 'medium' }) })}</p>
            </li>
          ))}
        </ul>
      )}
      <form action={action} className="space-y-2">
        <Button type="submit" variant="outline" disabled={pending}>{t('check')}</Button>
        <div role="status" aria-live="polite" className="text-sm">
          {state.status === 'done' && <p className="text-green-800">{state.awarded ? t('newBadges', { count: state.awarded }) : t('noneNew')}</p>}
          {state.status === 'failed' && <p className="text-red-700">{t('failed')}</p>}
        </div>
      </form>
    </section>
  );
}
