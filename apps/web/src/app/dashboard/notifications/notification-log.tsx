import { getFormatter, getTranslations } from 'next-intl/server';
import type { NotificationLogEntryDto } from '@echo-grid-feedback/shared-types';
import { Badge, Card, CardContent } from '@/components/ui';

const STATUS_VARIANT: Record<NotificationLogEntryDto['status'], 'success' | 'neutral' | 'danger'> = {
  sent: 'success',
  pending: 'neutral',
  failed: 'danger',
};

/** Matches notifications.json's staff.log.status.{sent,pending,failed} keys
 * 1:1 (i18n & Multi-Currency Block 7). */
function statusLabelKey(status: NotificationLogEntryDto['status']): string {
  return `staff.log.status.${status}`;
}

/** notifications:view-gated at the API -- see settings-form.tsx's comment
 * for why a Staff member without that grant sees the resulting error rather
 * than this section being hidden client-side (matches analytics/page.tsx's
 * identical, pre-existing gap with analytics:view). Read-only, no actions:
 * this is a send log for support/debugging, not a management surface. */
export async function NotificationLog({ entries }: { entries: NotificationLogEntryDto[] }) {
  // i18n & Multi-Currency Block 7 -- shared `notifications` namespace, see
  // lib/notification-preferences.ts's file comment for why event/channel
  // labels are looked up directly rather than through a static Record.
  const t = await getTranslations('notifications');

  if (entries.length === 0) {
    return <p className="py-4 text-sm text-neutral-500">{t('staff.log.empty')}</p>;
  }

  // i18n & Multi-Currency Block 3 -- 'shortDateTime' (not 'short'), since
  // this is a send log where the time genuinely matters, unlike the other
  // 5 fixed call sites which only ever showed a date.
  const format = await getFormatter();

  return (
    <Card>
      <CardContent className="flex flex-col divide-y divide-neutral-100 py-0">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-neutral-900">
                {t(`events.${entry.eventType}`)}
              </p>
              <p className="truncate text-xs text-neutral-500">
                {t(`channels.${entry.channel}`)} · {entry.recipientAddress} ·{' '}
                {format.dateTime(new Date(entry.createdAt), 'shortDateTime')}
              </p>
            </div>
            <Badge variant={STATUS_VARIANT[entry.status]} className="shrink-0">
              {t(statusLabelKey(entry.status))}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
