'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { ConversationDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

/**
 * Not wired through useActionState -- an imperative "find or create, then
 * navigate" action, same shape as deleteBranchAction (called directly, not
 * a form-state cycle) except this one redirects on success. Bound with
 * `.bind(null, customerId)` at the call site (dashboard/loyalty/page.tsx's
 * "Message" button), matching updateBranchAction's extra-argument pattern.
 */
export async function startConversationAction(customerId: string): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;

  const conversation = await apiFetch<ConversationDto>('/messaging/conversations', {
    method: 'POST',
    businessId: business.id,
    body: JSON.stringify({ customerId }),
  });

  redirect(`/dashboard/messages/${conversation.id}`);
}

export interface MessageFormState {
  error?: string;
  success?: boolean;
}

export async function sendMessageAction(
  conversationId: string,
  _prevState: MessageFormState,
  formData: FormData,
): Promise<MessageFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch(`/messaging/conversations/${conversationId}/messages`, {
      method: 'POST',
      businessId: business.id,
      body: JSON.stringify({ body: String(formData.get('body') ?? '') }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`/dashboard/messages/${conversationId}`);
  revalidatePath('/dashboard/messages');
  return { success: true };
}
