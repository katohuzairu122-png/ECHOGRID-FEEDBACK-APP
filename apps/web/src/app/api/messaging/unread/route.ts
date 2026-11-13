import { NextResponse } from 'next/server';
import type { MessagingUnreadSummaryDto } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusinessQuiet } from '@/lib/business';

export const dynamic = 'force-dynamic';

const NONE: MessagingUnreadSummaryDto = { unreadMessages: 0, unreadConversations: 0 };
const headers = { 'Cache-Control': 'no-store' };

/**
 * Unread customer messages for the signed-in staff member's active business, for the menu badge. Authorization is
 * the API's own (messages:view in the active business). Any failure, no business, no permission, signed out or the
 * API being slow, answers "none": a badge must never be able to break the page it sits on.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const business = await getActiveBusinessQuiet();
    if (!business) return NextResponse.json(NONE, { headers });
    const summary = await apiFetch<MessagingUnreadSummaryDto>('/messaging/unread-count', {
      businessId: business.id,
      cache: 'no-store',
    });
    return NextResponse.json(
      {
        unreadMessages: Math.max(0, Number(summary.unreadMessages) || 0),
        unreadConversations: Math.max(0, Number(summary.unreadConversations) || 0),
      },
      { headers },
    );
  } catch {
    return NextResponse.json(NONE, { headers });
  }
}
