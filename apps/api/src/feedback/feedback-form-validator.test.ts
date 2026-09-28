import { describe, expect, it } from 'vitest';
import { validateFeedbackAnswers } from './feedback-form-validator';
import type { PublicFeedbackForm } from '@echo-grid-feedback/shared-types';

const textId = '11111111-1111-4111-8111-111111111111';
const choiceId = '22222222-2222-4222-8222-222222222222';
const form: PublicFeedbackForm = {
  formId: '33333333-3333-4333-8333-333333333333',
  versionId: '44444444-4444-4444-8444-444444444444',
  version: 1,
  name: 'Visit feedback',
  questions: [
    { id: textId, key: 'service', label: 'How was service?', type: 'text', required: true, position: 0, options: null },
    { id: choiceId, key: 'area', label: 'Area', type: 'single_choice', required: false, position: 1, options: ['Dining', 'Delivery'] },
  ],
};

describe('validateFeedbackAnswers', () => {
  it('accepts answers that match the immutable published question definitions', () => {
    expect(() => validateFeedbackAnswers(form, [
      { questionId: textId, value: 'Excellent' },
      { questionId: choiceId, value: 'Dining' },
    ])).not.toThrow();
  });

  it('rejects missing required, unknown, duplicate, and invalid-choice answers', () => {
    expect(() => validateFeedbackAnswers(form, [])).toThrow();
    expect(() => validateFeedbackAnswers(form, [{ questionId: crypto.randomUUID(), value: 'x' }])).toThrow();
    expect(() => validateFeedbackAnswers(form, [{ questionId: textId, value: 'x' }, { questionId: textId, value: 'y' }])).toThrow();
    expect(() => validateFeedbackAnswers(form, [{ questionId: textId, value: 'x' }, { questionId: choiceId, value: 'Other' }])).toThrow();
  });
});

