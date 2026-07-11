import { getTranslations } from 'next-intl/server';
import type { MaterializedNotificationPreferenceDto } from '@echo-grid-feedback/shared-types';
import { CUSTOMER_NOTIFICATION_EVENT_TYPES, DELIVERABLE_NOTIFICATION_CHANNELS } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { NotificationPreferencesForm } from './notification-preferences-form';

interface NotificationsPageProps {
  params: Promise<{ businessId: string }>;
}

/**
 * Customer-facing preferences screen (Notifications Block 5), linked from
 * the business loyalty dashboard (../page.tsx). No enrollment check before
 * rendering -- GET/PATCH .../notification-preferences/:businessId (Block 4)
 * has none either, since a preference row with no matching loyalty account
 * is inert (nothing ever targets it; NotificationService only reaches a
 * customer recipient from an actual loyalty event) rather than a data leak,
 * so this stayed intentionally simple rather than re-deriving enrollment
 * state a second time on the frontend.
 */
export default async function CustomerNotificationsPage({ params }: NotificationsPageProps) {
  const { businessId } = await params;

  const preferences = await customerApiFetch<MaterializedNotificationPreferenceDto[]>(
    `/loyalty/me/notification-preferences/${businessId}`,
  );
  // i18n & Multi-Currency Block 7. Reads from the [businessId] layout's own
  // NextIntlClientProvider (Block 2), i.e. this business's locale.
  const t = await getTranslations('notifications.customer');

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <NotificationPreferencesForm
            businessId={businessId}
            eventTypes={CUSTOMER_NOTIFICATION_EVENT_TYPES}
            channels={DELIVERABLE_NOTIFICATION_CHANNELS}
            preferences={preferences}
          />
        </CardContent>
      </Card>
    </div>
  );
}
