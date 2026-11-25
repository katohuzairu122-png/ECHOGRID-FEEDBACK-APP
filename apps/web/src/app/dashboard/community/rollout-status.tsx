import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui';
import { OverviewPanel } from '@/components/workspace/overview-components';
import type { CommunityRollout } from '@/lib/business-community';

/**
 * The real rollout state, read from the API. "Open" is shown only when the API said open; a failed or unexpected read shows
 * "Status unavailable" for every capability and never an open state. Text and a badge carry the state (never colour alone).
 */
export function RolloutStatus({ rollout }: { rollout: CommunityRollout }) {
  const t = useTranslations('businessCommunity.status');
  const rows = [
    { key: 'enrollment', state: rollout.state === 'ready' ? rollout.status.enrollment : 'unknown' },
    { key: 'feed', state: rollout.state === 'ready' ? rollout.status.feed : 'unknown' },
    // Business publishing is not implemented: closed whatever the platform reports.
    { key: 'publishing', state: rollout.state === 'ready' ? ('closed' as const) : 'unknown' },
  ] as const;
  const anyOpen = rollout.state === 'ready' && (rollout.status.enrollment === 'open' || rollout.status.feed === 'open');
  const note = rollout.state !== 'ready' ? t('unknownNote') : rollout.status.enrollment === 'open' ? t('openNote') : t('closedNote');
  return (
    <OverviewPanel title={t('title')}>
      <p className="text-sm text-neutral-600">{t('description')}</p>
      <ul className="mt-3 divide-y divide-neutral-200" data-testid="community-rollout" data-any-open={anyOpen ? 'true' : 'false'}>
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3 py-2 text-sm" data-capability={row.key} data-state={row.state}>
            <span>{t(`capabilities.${row.key}`)}</span>
            <Badge variant={row.state === 'open' ? 'success' : 'neutral'}>{t(`state.${row.state}`)}</Badge>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm" role="status">{note}</p>
    </OverviewPanel>
  );
}
