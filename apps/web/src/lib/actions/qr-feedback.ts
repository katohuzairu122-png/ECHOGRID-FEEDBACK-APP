'use server';

import { publicApiFetch } from '@/lib/public-api-client';
import { ApiError } from '@/lib/api-client';
import { readFeedbackForm } from '@/lib/feedback-form';

export interface FeedbackFormState {
  error?: string;
  success?: boolean;
}

/**
 * Bound with `.bind(null, token)` at the call site (feedback-form.tsx), same
 * pattern updateBranchAction uses for branchId -- keeps the (prevState,
 * formData) shape useActionState requires while still scoping the
 * submission to the QR code the customer actually scanned. No
 * revalidatePath call: unlike branch mutations, nothing else in the app
 * reads this data through a cache that needs invalidating.
 */
export async function submitFeedbackAction(
  token: string,
  _prevState: FeedbackFormState,
  formData: FormData,
): Promise<FeedbackFormState> {
  try {
    await publicApiFetch(`/qr/${token}/feedback`, {
      method: 'POST',
      body: JSON.stringify(readFeedbackForm(formData)),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  return { success: true };
}
