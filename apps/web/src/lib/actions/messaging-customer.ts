'use server';

import { revalidatePath } from 'next/cache';
import { customerApiFetch } from '@/lib/customer-api-client';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { ApiError } from '@/lib/api-client';

export interface MessageFormState {
  error?: string;
  success?: boolean;
}

export async function sendReplyAction(
  businessId: string,
  _prevState: MessageFormState,
  formData: FormData,
): Promise<MessageFormState> {
  try {
    await customerApiFetch(`/messaging/me/conversations/${businessId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: String(formData.get('body') ?? '') }),
    });
  } catch (err) {
    // First, always: customerApiFetch redirects to /loyalty/login on a 401,
    // and redirect() signals that by throwing. Without this line the
    // sentinel falls through to the generic branch below, the navigation is
    // cancelled, and the customer sees "Something went wrong" instead of a
    // sign-in page. See lib/rethrow-control-flow.ts.
    rethrowControlFlow(err);
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`/loyalty/dashboard/${businessId}/messages`);
  return { success: true };
}
