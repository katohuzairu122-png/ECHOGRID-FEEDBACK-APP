import { NextResponse } from 'next/server';
import type { CustomerMessagingUnreadSummaryDto } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';

export const dynamic = 'force-dynamic';

const NONE: CustomerMessagingUnreadSummaryDto = {
  unreadMessages: 0,
  unreadConversations: 0,
  byBusiness: [],
};
const headers = { 'Cache-Control': 'no-store' };

/**
 * Unread business messages for the signed-in customer, for the My Rewards badge. Any failure, including being signed
 * out (customerApiFetch's redirect is swallowed here on purpose), answers "none": a badge must never break a page.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const summary = await customerApiFetch<CustomerMessagingUnreadSummaryDto>(
      '/messaging/me/unread-count',
      {
        cache: 'no-store',
      },
    );
    return NextResponse.json(
      {
        unreadMessages: Math.max(0, Number(summary.unreadMessages) || 0),
        unreadConversations: Math.max(0, Number(summary.unreadConversations) || 0),
        byBusiness: Array.isArray(summary.byBusiness) ? summary.byBusiness : [],
      },
      { headers },
    );
  } catch {
    return NextResponse.json(NONE, { headers });
  }
}
