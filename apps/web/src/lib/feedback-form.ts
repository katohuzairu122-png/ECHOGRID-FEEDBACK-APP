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

  const answers = [...formData.keys()]
    .filter((key) => key.startsWith('answer:'))
    .filter((key, index, all) => all.indexOf(key) === index)
    .filter((key) => formData.getAll(key).some((value) => String(value).trim() !== ''))
    .map((key) => {
      const [, questionId, type] = key.split(':');
      const values = formData.getAll(key).map(String);
      const raw = values[0] ?? '';
      const value = type === 'rating' ? Number(raw) : type === 'boolean' ? raw === 'true' : type === 'multi_choice' ? values : raw;
      return { questionId: questionId!, value };
    });

  const feedbackType = optional('feedbackType');
  const details = optional('comment');
  const suggestion = optional('suggestion');
  const advice = optional('advice');
  const hasStructuredFields = Boolean(feedbackType || suggestion || advice);
  const comment = hasStructuredFields
    ? [
        feedbackType ? `Type: ${feedbackType}` : undefined,
        details ? `Details: ${details}` : undefined,
        suggestion ? `Suggestion: ${suggestion}` : undefined,
        advice ? `Advice: ${advice}` : undefined,
      ].filter(Boolean).join('\n\n') || undefined
    : details;

  return {
    submissionKey: String(formData.get('submissionKey')),
    formVersionId: optional('formVersionId'),
    answers: answers.length ? answers : undefined,
    rating: Number(formData.get('rating')),
    comment,
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


