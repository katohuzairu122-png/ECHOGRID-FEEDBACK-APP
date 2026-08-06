import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ConversationWithCustomerDto, MessageDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch, ApiError } from '@/lib/api-client';
import { Card, CardContent } from '@/components/ui';
import { ReplyForm } from './reply-form';

interface MessageThreadPageProps {
  params: Promise<{ conversationId: string }>;
}

export default async function MessageThreadPage({ params }: MessageThreadPageProps) {
  const { conversationId } = await params;
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  const format = await getFormatter();
  const t = await getTranslations('messaging.staff.thread');

  let conversation: ConversationWithCustomerDto;
  try {
    conversation = await apiFetch<ConversationWithCustomerDto>(`/messaging/conversations/${conversationId}`, {
      businessId: business.id,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  // Marks unread (customer-sent) messages as read for this business's staff
  // as a whole -- a plain upstream API call during render, not a Next
  // cache/cookie mutation, so it's fine to call directly here rather than
  // through a Server Action (same reasoning notifications/page.tsx and
  // loyalty/dashboard/[businessId]/messages/page.tsx apply).
  await apiFetch(`/messaging/conversations/${conversationId}/read`, {
    method: 'POST',
    businessId: business.id,
  });

  const messages = await apiFetch<MessageDto[]>(`/messaging/conversations/${conversationId}/messages`, {
    businessId: business.id,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard/messages" className="text-sm text-brand-700 hover:underline">
          {t('backToList')}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-900">
          {conversation.customer.fullName ?? conversation.customer.phone}
        </h1>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          {messages.length === 0 ? (
            <p className="text-sm text-neutral-500">{t('emptyThread')}</p>
          ) : (
            [...messages].reverse().map((message) => (
              <div
                key={message.id}
                className={`flex flex-col gap-0.5 ${message.senderType === 'staff' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    message.senderType === 'staff'
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
            ))
          )}
        </CardContent>
      </Card>

      <ReplyForm conversationId={conversationId} />
    </div>
  );
}
