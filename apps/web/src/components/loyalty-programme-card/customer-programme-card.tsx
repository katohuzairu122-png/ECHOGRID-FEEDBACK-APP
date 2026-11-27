import { useFormatter, useTranslations } from 'next-intl';
import type { CustomerProgrammeCardDto, ProgrammeCardView } from '@echo-grid-feedback/shared-types';
import { Card, CardContent, CardHeader, CardTitle, Progress } from '@/components/ui';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * LPC-07: the customer's card for the business's active programme: their own progress and the programme's public terms, plus rewards they have
 * earned and not yet received. Presentational: all data comes from GET /loyalty/me/accounts/:businessId/programme.
 */
export function CustomerProgrammeCard({ card }: { card: CustomerProgrammeCardDto }) {
  const currency = card.currency;
  const t = useTranslations('loyalty.customer.businessDashboard.programme');
  const format = useFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const programme = card.programme;
  const name = (id: string) => programme?.rewardNames[id] ?? t('aReward');
  const view = programme?.view;
  const body = view ? renderView(view) : null;
  if (!body && card.earnedRewards.length === 0) return null;

  function renderView(v: ProgrammeCardView) {
    switch (v.kind) {
      case 'points':
        return null; // the points balance and tier progress above already are this programme's card
      case 'stamps':
        return (
          <>
            <Progress value={v.fraction * 100} label={v.expired ? t('stamps.expired') : t('stamps.count', { stamps: v.stamps, threshold: v.threshold })} />
            <p className="text-sm text-neutral-700">{t('stamps.reward', { reward: name(v.rewardId) })}</p>
            {v.expiresAt ? <p className="text-xs text-neutral-500">{t('stamps.expires', { date: date(v.expiresAt) })}</p> : null}
            {v.completedCards > 0 ? <p className="text-xs text-neutral-500">{t('stamps.completed', { count: v.completedCards })}</p> : null}
          </>
        );
      case 'milestones':
        return (
          <>
            <Progress value={v.fraction * 100} label={t(`milestones.current.${v.metric}`, { value: v.current, currency })} />
            <ul className="space-y-1 text-sm">
              {v.ladder.map((m) => (
                <li key={m.threshold} className="flex items-center justify-between gap-3">
                  <span>{t(`milestones.step.${v.metric}`, { value: m.threshold, currency, reward: name(m.rewardId) })}</span>
                  <span className={m.achieved ? 'text-emerald-700' : 'text-neutral-500'}>{m.achieved ? t('milestones.achieved') : t('milestones.locked')}</span>
                </li>
              ))}
            </ul>
          </>
        );
      case 'streak':
        return (
          <>
            <Progress value={v.fraction * 100} label={t(`streak.progress.${v.period}`, { streak: v.streak, required: v.required })} />
            <p className="text-sm text-neutral-700">{t('streak.reward', { reward: name(v.rewardId) })}</p>
            {v.gracePeriods > 0 ? <p className="text-xs text-neutral-500">{t(`streak.grace.${v.period}`, { count: v.gracePeriods })}</p> : null}
          </>
        );
      case 'missions':
        return (
          <ul className="space-y-3">
            {v.missions.map((m) => (
              <li key={m.key} className="space-y-1">
                <Progress
                  value={m.fraction * 100}
                  label={t(`missions.objective.${m.objective}`, { current: m.current, target: m.target, currency })}
                />
                <p className="text-xs text-neutral-600">
                  {t('missions.reward', { reward: name(m.rewardId) })} · {t(`missions.status.${m.status}`)}
                  {m.endsAt ? ` · ${t('missions.ends', { date: date(m.endsAt) })}` : ''}
                </p>
              </li>
            ))}
          </ul>
        );
      case 'offpeak':
        return (
          <>
            <p className="text-sm text-neutral-700">{t('offpeak.intro')}</p>
            <ul className="space-y-1 text-sm">
              {v.windows.map((w, i) => (
                <li key={i}>
                  {w.days.map((d) => t(`days.${DAY_KEYS[d % 7]!}`)).join(', ')} · {w.start}–{w.end} ·{' '}
                  {w.multiplier ? t('offpeak.multiplier', { value: w.multiplier }) : t('offpeak.bonus', { points: w.bonusPoints ?? 0 })}
                </li>
              ))}
            </ul>
            {v.effectiveUntil ? <p className="text-xs text-neutral-500">{t('offpeak.until', { date: date(v.effectiveUntil) })}</p> : null}
          </>
        );
    }
  }

  return (
    <Card data-testid="programme-card">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {body}
        {card.earnedRewards.length > 0 ? (
          <div data-testid="earned-waiting" className="space-y-1 rounded-lg bg-emerald-50 p-3">
            <p className="text-sm font-semibold text-emerald-900">{t('earned.title')}</p>
            <p className="text-xs text-emerald-900">{t('earned.hint')}</p>
            <ul className="text-sm text-emerald-900">
              {card.earnedRewards.map((r, i) => (
                <li key={i}>
                  {r.rewardName}
                  {r.expiresAt ? ` · ${t('earned.expires', { date: date(r.expiresAt) })}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
