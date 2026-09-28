import type { FeedbackAnswerInput, PublicFeedbackForm } from '@echo-grid-feedback/shared-types';
import { AppError } from '../lib/errors';

export function validateFeedbackAnswers(form: PublicFeedbackForm, answers: FeedbackAnswerInput[]): void {
  const questions = new Map(form.questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = questions.get(answer.questionId);
    if (!question || seen.has(answer.questionId)) invalid();
    seen.add(answer.questionId);
    const value = answer.value;
    const valid =
      ((question.type === 'text' || question.type === 'textarea') && typeof value === 'string' && value.length <= 2000) ||
      (question.type === 'rating' && typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5) ||
      (question.type === 'boolean' && typeof value === 'boolean') ||
      (question.type === 'single_choice' && typeof value === 'string' && Boolean(question.options?.includes(value))) ||
      (question.type === 'multi_choice' && Array.isArray(value) && value.every((v) => question.options?.includes(v)));
    if (!valid) invalid();
  }
  for (const question of form.questions) {
    if (question.required && !seen.has(question.id)) invalid();
  }
}

function invalid(): never {
  throw new AppError('Answers do not match the published feedback form.', 422, 'INVALID_FORM_ANSWERS');
}

