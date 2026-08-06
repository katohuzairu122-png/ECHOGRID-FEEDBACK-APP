import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ConversationWithCustomerDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

/** Staff landing page for Messages -- the conversation list, same card-list
 * shape as dashboard/loyalty/page.tsx's accounts list. */
export default async function MessagesPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  const format = await getFormatter();
  const t = await getTranslations('messaging.staff');

  const conversations = await apiFetch<ConversationWithCustomerDto[]>('/messaging/conversations?limit=50', {
    businessId: business.id,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{business.name}</p>
      </div>

      {conversations.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyTitle')}</CardTitle>
            <CardDescription>{t('emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {conversations.map((conversation) => (
            <Link key={conversation.id} href={`/dashboard/messages/${conversation.id}`}>
              <Card className="transition-colors hover:border-brand-300">
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-neutral-900">
                        {conversation.customer.fullName ?? conversation.customer.phone}
                      </p>
                      {conversation.unreadCount > 0 && (
                        <Badge variant="accent">{t('unreadCount', { count: conversation.unreadCount })}</Badge>
                      )}
                    </div>
                    {conversation.lastMessagePreview && (
                      <p className="line-clamp-1 text-sm text-neutral-500">
                        {conversation.lastMessagePreview}
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-neutral-500">
                    {format.dateTime(new Date(conversation.lastMessageAt), 'short')}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
