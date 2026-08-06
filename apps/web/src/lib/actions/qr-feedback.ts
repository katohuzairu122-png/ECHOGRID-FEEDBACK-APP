'use server';

import type { FollowUpQuestionDto } from '@echo-grid-feedback/shared-types';
import { publicApiFetch } from '@/lib/public-api-client';
import { ApiError } from '@/lib/api-client';
import { readFeedbackForm } from '@/lib/feedback-form';

export interface FeedbackFormState {
  error?: string;
  success?: boolean;
}

export interface FollowUpQuestionState {
  /** Step 1 completed successfully -- gates rendering step 2, regardless of
   * whether a question actually came back. */
  ready?: boolean | undefined;
  question?: string | undefined;
  rating?: number | undefined;
  comment?: string | undefined;
  customerName?: string | undefined;
  customerEmail?: string | undefined;
  customerPhone?: string | undefined;
}

/**
 * Step 1 of the flow: reads the rating/comment/contact fields, then asks the
 * API for a follow-up question. The question is strictly a nice-to-have --
 * any failure (rate-limited, Anthropic outage, revoked token) is swallowed
 * here rather than surfaced as a customer-facing error, so the customer
 * always reaches step 2 and can still complete their submission.
 */
export async function generateFollowUpQuestionAction(
  token: string,
  _prevState: FollowUpQuestionState,
  formData: FormData,
): Promise<FollowUpQuestionState> {
  const parsed = readFeedbackForm(formData);

  let question: string | undefined;
  try {
    const result = await publicApiFetch<FollowUpQuestionDto>(`/qr/${token}/follow-up-question`, {
      method: 'POST',
      body: JSON.stringify({ rating: parsed.rating, comment: parsed.comment }),
    });
    question = result.question;
  } catch {
    question = undefined;
  }

  return {
    ready: true,
    question,
    rating: parsed.rating,
    comment: parsed.comment,
    customerName: parsed.customerName,
    customerEmail: parsed.customerEmail,
    customerPhone: parsed.customerPhone,
  };
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
