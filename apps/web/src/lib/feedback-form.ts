import type { SubmitFeedbackInput } from '@echo-grid-feedback/shared-types';

/**
 * Mirrors lib/branch-form.ts's pattern exactly: kept out of the 'use server'
 * action file (whose every export must be async) and out of the action
 * function itself, so it's directly unit-testable with no Server Action
 * machinery involved. No rejection of a missing/invalid rating here -- like
 * readBranchForm, this only coerces FormData's string shape into
 * SubmitFeedbackInput's shape; the shared submitFeedbackSchema (enforced
 * server-side via the API's parseJsonBody) is the actual source of truth
 * for validity, so a missing rating surfaces as a normal ApiError message,
 * not a special local case.
 */
export function readFeedbackForm(formData: FormData): SubmitFeedbackInput {
  const optional = (key: string): string | undefined => {
    const value = formData.get(key);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };

  return {
    rating: Number(formData.get('rating')),
    comment: optional('comment'),
    customerName: optional('customerName'),
    customerEmail: optional('customerEmail'),
    customerPhone: optional('customerPhone'),
    followUpQuestion: optional('followUpQuestion'),
    // The Skip button submits a distinct `skipFollowUp` flag so a customer
    // who typed an answer and then clicked Skip doesn't accidentally submit
    // it -- more robust than relying on client JS to clear the textarea.
    followUpAnswer: formData.get('skipFollowUp') ? undefined : optional('followUpAnswer'),
  };
}
