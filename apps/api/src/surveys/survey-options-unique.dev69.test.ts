import { describe, expect, it } from 'vitest';
import {
  createSurveyVersionSchema,
  surveyQuestionInputSchema,
} from '@echo-grid-feedback/shared-types';

const base = {
  key: 'experience',
  label: 'What stood out?',
  type: 'multi_choice' as const,
  required: true,
  options: ['Service', 'Quality', 'Value'],
};

describe('DEV-69 unique published survey choice vocabulary', () => {
  it.each([
    { name: 'exact duplicate', options: ['Service', 'Service'] },
    { name: 'duplicate after trimming', options: ['Service', ' Service '] },
    { name: 'later duplicate', options: ['Service', 'Quality', 'Service'] },
  ])('rejects $name before publishing the question', ({ options }) => {
    const result = surveyQuestionInputSchema.safeParse({ ...base, options });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: expect.arrayContaining(['options']),
          message: 'Choice question options must be unique.',
        }),
      ]));
    }
  });

  it('applies the same constraint to single_choice', () => {
    expect(surveyQuestionInputSchema.safeParse({
      ...base,
      type: 'single_choice',
      options: ['Yes', 'Yes'],
    }).success).toBe(false);
  });

  it('preserves valid, distinct choice options and their existing normalized form', () => {
    const result = surveyQuestionInputSchema.safeParse({
      ...base,
      options: ['Service ', ' Quality', 'Value'],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.options).toEqual(['Service', 'Quality', 'Value']);
  });

  it('rejects duplicate options at the version publication input boundary', () => {
    const input = {
      title: 'Visit survey',
      questions: [{ ...base, options: ['Service', 'Service'] }],
    };
    const result = createSurveyVersionSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['questions', 0, 'options', 1] }),
      ]));
    }
  });

  it('leaves non-choice question definitions untouched', () => {
    const result = surveyQuestionInputSchema.safeParse({
      key: 'comment', label: 'Your comment', type: 'text', required: false,
    });
    expect(result.success).toBe(true);
  });
});
