'use client';

import { useActionState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { reversePurchaseAction, type ReversalFormState } from '@/lib/actions/loyalty-purchases';
import type { PurchaseDto, ReversalPreviewDto, RewardImpactDto } from '@/lib/loyalty-purchases';
import { Button, Label, Textarea } from '@/components/ui';

function RewardImpact({ items }: { items: RewardImpactDto[] }) {
  const t = useTranslations('loyalty.purchases.impact');
  if (items.length === 0) return <p className="text-sm text-neutral-600">{t('noRewards')}</p>;
  return (
    <ul className="space-y-1 text-sm">
      {items.map((item, i) => (
        <li key={i} data-testid={`impact-${item.outcome}`} className={item.outcome === 'already_used' ? 'font-medium text-amber-800' : undefined}>
          {t(item.outcome === 'revoked' ? 'revoked' : 'alreadyUsed', { reward: item.rewardName })}
        </li>
      ))}
    </ul>
  );
}

/**
 * LPC-10: the reversal screen for ONE purchase. It shows what the reversal would do (an exact preview from the API), asks for a reason and an explicit
 * confirmation, then reports the result: points taken back, the shortfall, rewards revoked and any reward that was already handed over (flagged for
 * review). A reversed purchase shows its recorded outcome instead of the form, so a duplicate cannot be submitted from here; the API refuses it too.
 */
export function ReversalPanel({ purchase, currency, preview, previewError }: { purchase: PurchaseDto; currency: string; preview: ReversalPreviewDto | null; previewError?: 'ALREADY_REVERSED' | 'UNAVAILABLE' | undefined }) {
  const t = useTranslations('loyalty.purchases');
  const format = useFormatter();
  const [state, action, pending] = useActionState<ReversalFormState, FormData>(reversePurchaseAction, {});
  const done = state.result;

  return (
    <div className="space-y-4">
      <section aria-label={t('detail.title')} className="space-y-2 rounded-xl border bg-white p-5" data-testid="purchase-detail">
        <h2 className="font-semibold">{t('detail.title')}</h2>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-neutral-500">{t('columns.customer')}</dt><dd>{purchase.customerName ?? t('unnamed')}</dd>
          <dt className="text-neutral-500">{t('columns.date')}</dt><dd>{format.dateTime(new Date(purchase.occurredAt), { dateStyle: 'medium', timeStyle: 'short' })}</dd>
          <dt className="text-neutral-500">{t('columns.amount')}</dt><dd className="tabular-nums">{purchase.amount} {currency}</dd>
          <dt className="text-neutral-500">{t('detail.channel')}</dt><dd>{purchase.channel}</dd>
          <dt className="text-neutral-500">{t('detail.pointsEarned')}</dt><dd className="tabular-nums">{purchase.pointsEarned}</dd>
          <dt className="text-neutral-500">{t('columns.status')}</dt><dd>{t(`status.${purchase.status}`)}</dd>
        </dl>
      </section>

      {done ? (
        <section role="status" className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-5" data-testid="reversal-result">
          <h2 className="font-semibold text-emerald-900">{t('result.title')}</h2>
          <p className="text-sm text-emerald-900">{t('result.points', { count: done.pointsReversed })}</p>
          {done.pointsShortfall > 0 ? <p className="text-sm font-medium text-amber-800" data-testid="shortfall">{t('result.shortfall', { count: done.pointsShortfall })}</p> : null}
          <RewardImpact items={done.rewardImpact} />
          {done.needsReview ? <p className="text-sm font-medium text-amber-800" data-testid="needs-review">{t('result.needsReview')}</p> : null}
        </section>
      ) : purchase.status !== 'confirmed' || previewError === 'ALREADY_REVERSED' ? (
        <section className="space-y-2 rounded-xl border bg-neutral-50 p-5" data-testid="already-reversed">
          <h2 className="font-semibold">{t('reversedRecord.title')}</h2>
          {purchase.reversal ? (
            <>
              <p className="text-sm">{t('reversedRecord.when', { date: format.dateTime(new Date(purchase.reversal.reversedAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</p>
              <p className="text-sm">{t('result.points', { count: purchase.reversal.pointsReversed })}</p>
              {purchase.reversal.pointsShortfall > 0 ? <p className="text-sm font-medium text-amber-800">{t('result.shortfall', { count: purchase.reversal.pointsShortfall })}</p> : null}
            </>
          ) : null}
          <p className="text-sm text-neutral-600">{t('reversedRecord.final')}</p>
        </section>
      ) : (
        <>
          <section aria-label={t('impact.title')} className="space-y-2 rounded-xl border bg-white p-5" data-testid="reversal-preview">
            <h2 className="font-semibold">{t('impact.title')}</h2>
            {preview ? (
              <>
                <p className="text-sm">{t('impact.points', { count: preview.pointsReversed })}</p>
                {preview.pointsShortfall > 0 ? <p className="text-sm font-medium text-amber-800">{t('impact.shortfall', { count: preview.pointsShortfall })}</p> : null}
                <RewardImpact items={preview.rewardImpact} />
                {preview.frozenProgrammes > 0 ? <p className="text-xs text-neutral-600">{t('impact.frozen')}</p> : null}
                <p className="text-xs text-neutral-500">{t('impact.rules')}</p>
              </>
            ) : (
              <p role="alert" className="text-sm text-amber-800">{t('impact.unavailable')}</p>
            )}
          </section>

          <form action={action} className="space-y-3 rounded-xl border bg-white p-5" data-testid="reversal-form">
            <h2 className="font-semibold">{t('form.title')}</h2>
            <input type="hidden" name="purchaseId" value={purchase.id} />
            <Label htmlFor="reason">{t('form.reason')}</Label>
            <Textarea id="reason" name="reason" required minLength={3} maxLength={200} rows={3} aria-describedby="reason-hint" />
            <p id="reason-hint" className="text-xs text-neutral-500">{t('form.reasonHint')}</p>
            <div className="flex items-start gap-2">
              <input id="confirm" name="confirm" type="checkbox" value="yes" required className="mt-1 h-4 w-4" />
              <Label htmlFor="confirm" className="text-sm font-normal">{t('form.confirm')}</Label>
            </div>
            {state.errorCode ? <p role="alert" className="text-sm text-danger">{t(`errors.${state.errorCode}`)}</p> : null}
            <Button type="submit" disabled={pending || !preview} className="w-full sm:w-auto">{pending ? t('form.submitting') : t('form.submit')}</Button>
          </form>
        </>
      )}
    </div>
  );
}
