import { useTranslations } from 'next-intl';
import { MetricCard } from '@/components/workspace/overview-components';
import styles from '@/components/workspace/workspace.module.css';
import type { CommunityParticipation } from '@/lib/business-community';

type Key = 'eligible' | 'participants' | 'rate';

/**
 * The three participation totals. A shown number is exactly what the server returned; a suppressed figure says that the group is too small to
 * be shown (never a number, never "0"); an unavailable result says the figures could not be read. Nothing here is computed or estimated.
 */
export function ParticipationMetrics({ result, labels, testId }: { result: CommunityParticipation; labels: Record<Key, string>; testId: string }) {
  const t = useTranslations('businessCommunity.participation');
  const render = (key: Key) => {
    if (result.state !== 'ready') return { text: t('unavailableShort'), hint: t('unavailableTitle') };
    const figure = key === 'rate' ? result.data.ratePercent : result.data[key];
    if (figure.state === 'suppressed') return { text: t('suppressedShort'), hint: t('suppressed', { min: result.data.minimumGroupSize }) };
    return { text: key === 'rate' ? `${figure.value}%` : String(figure.value), hint: t(`hints.${key}`) };
  };
  return (
    <div className={`${styles.metricGrid} mt-3`} data-testid={testId}>
      {(['eligible', 'participants', 'rate'] as const).map((key) => {
        const { text, hint } = render(key);
        const isNumber = /^\d/.test(text);
        return (
          <MetricCard
            key={key}
            label={labels[key]}
            value={isNumber ? text : <span className="text-base font-semibold leading-snug">{text}</span>}
            hint={hint}
            icon={key === 'rate' ? 'chart' : 'users'}
          />
        );
      })}
    </div>
  );
}
