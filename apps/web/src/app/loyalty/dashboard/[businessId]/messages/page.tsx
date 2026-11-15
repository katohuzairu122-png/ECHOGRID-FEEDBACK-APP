import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { ConversationWithBusinessDto, MessageDto } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { ApiError } from '@/lib/api-error';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { MessagesLoadFailure } from './messages-load-failure';
import { ReplyForm } from './reply-form';

interface CustomerMessagesPageProps {
  params: Promise<{ businessId: string }>;
  searchParams: Promise<{ offset?: string }>;
}

/**
 * Customer-facing thread view. Unlike the staff side (notFound() on a
 * missing conversation), absence here is a normal, expected state -- staff
 * simply hasn't messaged this customer yet -- so it renders an empty-state
 * card instead, same "inert, not a data leak" distinction
 * notifications/page.tsx's own comment draws.
 */
export default async function CustomerMessagesPage({
  params,
  searchParams,
}: CustomerMessagesPageProps) {
  const { businessId } = await params;
  const { offset: rawOffset } = await searchParams;
  const offset =
    rawOffset &&
    /^(?:0|[1-9][0-9]*)$/.test(rawOffset) &&
    Number(rawOffset) <= 1_000_000 &&
    Number.isSafeInteger(Number(rawOffset))
      ? Number(rawOffset)
      : 0;
  const pageSize = 100;
  const format = await getFormatter();
  const t = await getTranslations('loyalty.customer.messages');

  const basePath = `/loyalty/dashboard/${encodeURIComponent(businessId)}/messages`;
  const threadPath = `/messaging/me/conversations/${encodeURIComponent(businessId)}`;
  const loginNext = offset ? `${basePath}?offset=${offset}` : basePath;

  let messages: MessageDto[];
  try {
    await customerApiFetch<ConversationWithBusinessDto>(threadPath, {}, loginNext);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyTitle')}</CardTitle>
            <CardDescription>{t('emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      );
    }
    return recover(error);
  }

  try {
    await customerApiFetch(`${threadPath}/read`, { method: 'POST' }, loginNext);
    messages = await customerApiFetch<MessageDto[]>(
      `${threadPath}/messages?limit=${pageSize}&offset=${offset}`,
      {},
      loginNext,
    );
  } catch (error) {
    return recover(error);
  }

  function recover(error: unknown) {
    if (error instanceof ApiError && error.status === 429) {
      // The customer API limiter uses a 60-second window. Wait a full window
      // because the existing API error envelope does not carry Retry-After.
      return <MessagesLoadFailure kind="rateLimited" retryAt={Date.now() + 60_000} />;
    }
    if ((error instanceof ApiError && error.status >= 500) || error instanceof TypeError) {
      return <MessagesLoadFailure kind="unavailable" />;
    }
    // Preserve Next.js redirect exceptions and the existing permission/error boundary.
    throw error;
  }

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
                  message.senderType === 'customer' ? 'ws-solid' : 'bg-neutral-100 text-neutral-900'
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

      <nav
        aria-label="Message history pages"
        className="flex items-center justify-between gap-4 text-sm"
      >
        {offset > 0 ? (
          <Link
            className="text-brand-700 underline"
            href={`${basePath}?offset=${Math.max(0, offset - pageSize)}`}
          >
            Newer messages
          </Link>
        ) : (
          <span />
        )}
        {messages.length === pageSize && offset + pageSize <= 1_000_000 ? (
          <Link
            className="text-brand-700 underline"
            href={`${basePath}?offset=${offset + pageSize}`}
          >
            Older messages
          </Link>
        ) : (
          <span />
        )}
      </nav>

      <ReplyForm businessId={businessId} />
    </div>
  );
}
