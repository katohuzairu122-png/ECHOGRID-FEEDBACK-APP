'use server';

import { revalidatePath } from 'next/cache';
import { customerApiFetch } from '@/lib/customer-api-client';
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
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`/loyalty/dashboard/${businessId}/messages`);
  return { success: true };
}
