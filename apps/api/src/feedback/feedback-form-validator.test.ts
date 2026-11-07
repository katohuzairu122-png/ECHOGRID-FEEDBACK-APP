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

const multiId = '55555555-5555-4555-8555-555555555555';
const multiForm: PublicFeedbackForm = {
  ...form,
  questions: [
    ...form.questions,
    { id: multiId, key: 'channels', label: 'Preferred channels', type: 'multi_choice',
      required: true, position: 2, options: ['Email', 'SMS', 'In-App'] },
  ],
};
const baseAnswers = [{ questionId: textId, value: 'Helpful staff' }];

describe('DEV-66 published form answer cardinality and integrity', () => {
  it('accepts distinct valid multi-choice selections', () => {
    expect(() => validateFeedbackAnswers(multiForm, [
      ...baseAnswers,
      { questionId: multiId, value: ['Email', 'In-App'] },
    ])).not.toThrow();
  });

  it.each([
    { choices: [] },
    { choices: ['Email', 'Email'] },
    { choices: ['SMS', 'SMS', 'SMS'] },
    { choices: ['Email', 'SMS', 'In-App', 'Email'] },
    { choices: ['Other'] },
    { choices: [23] },
    { choices: [null] },
    { choices: ['Email', null] },
  ])('rejects invalid, empty, duplicate or unknown selections %#', ({ choices }) => {
    expect(() => validateFeedbackAnswers(multiForm, [
      ...baseAnswers,
      { questionId: multiId, value: choices as unknown as string[] },
    ])).toThrow();
  });

  it('still permits an unanswered optional multi-choice question', () => {
    const optional: PublicFeedbackForm = {
      ...multiForm,
      questions: multiForm.questions.map(q => q.id === multiId ? { ...q, required: false } : q),
    };
    expect(() => validateFeedbackAnswers(optional, baseAnswers)).not.toThrow();
    expect(() => validateFeedbackAnswers(optional, [
      ...baseAnswers, { questionId: multiId, value: [] },
    ])).not.toThrow();
  });

  it('rejects a blank or whitespace-only answer to a required text question', () => {
    for (const value of ['', ' ', '\t', '\n']) {
      expect(() => validateFeedbackAnswers(form, [{ questionId: textId, value }])).toThrow();
    }
    expect(() => validateFeedbackAnswers(form, [{ questionId: textId, value: ' Great ' }]))
      .not.toThrow();
  });

  it('does not require nonblank text for an explicitly optional text field', () => {
    const optional: PublicFeedbackForm = {
      ...form,
      questions: form.questions.map(q => q.id === textId ? { ...q, required: false } : q),
    };
    expect(() => validateFeedbackAnswers(optional, [{ questionId: textId, value: '' }]))
      .not.toThrow();
  });
});
