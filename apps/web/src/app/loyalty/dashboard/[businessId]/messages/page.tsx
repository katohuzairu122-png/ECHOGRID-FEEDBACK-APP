import { getFormatter, getTranslations } from 'next-intl/server';
import type { ConversationWithBusinessDto, MessageDto } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { ApiError } from '@/lib/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { ReplyForm } from './reply-form';

interface CustomerMessagesPageProps {
  params: Promise<{ businessId: string }>;
}

/**
 * Customer-facing thread view. Unlike the staff side (notFound() on a
 * missing conversation), absence here is a normal, expected state -- staff
 * simply hasn't messaged this customer yet -- so it renders an empty-state
 * card instead, same "inert, not a data leak" distinction
 * notifications/page.tsx's own comment draws.
 */
export default async function CustomerMessagesPage({ params }: CustomerMessagesPageProps) {
  const { businessId } = await params;
  const format = await getFormatter();
  const t = await getTranslations('loyalty.customer.messages');

  let conversation: ConversationWithBusinessDto | undefined;
  try {
    conversation = await customerApiFetch<ConversationWithBusinessDto>(`/messaging/me/conversations/${businessId}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }

  if (!conversation) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('emptyTitle')}</CardTitle>
          <CardDescription>{t('emptyDescription')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Plain upstream API call during render, same reasoning as the staff
  // thread page's identical comment.
  await customerApiFetch(`/messaging/me/conversations/${businessId}/read`, { method: 'POST' });

  const messages = await customerApiFetch<MessageDto[]>(`/messaging/me/conversations/${businessId}/messages`);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>

      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          {[...messages].reverse().map((message) => (
            <div
              key={message.id}
              className={`flex flex-col gap-0.5 ${message.senderType === 'customer' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  message.senderType === 'customer'
                    ? 'bg-brand-600 text-white'
                    : 'bg-neutral-100 text-neutral-900'
                }`}
              >
                {message.body}
              </div>
              <p className="text-xs text-neutral-400">
                {format.dateTime(new Date(message.createdAt), 'short')}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <ReplyForm businessId={businessId} />
    </div>
  );
}
