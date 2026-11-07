import { describe, expect, it } from 'vitest';
import type { SurveyQuestion } from '../repositories';
import { assertAnswerValue } from './survey-participation.service';

const q = (
  type: SurveyQuestion['type'],
  required: boolean,
  options: string[] | null = null,
): SurveyQuestion => ({
  id: '11111111-1111-4111-8111-111111111111',
  key: 'question',
  type,
  required,
  options,
  validation: null,
} as SurveyQuestion);

const invalid = (question: SurveyQuestion, value: unknown): void => {
  try {
    assertAnswerValue(question, value as Parameters<typeof assertAnswerValue>[1]);
    throw new Error('EXPECTED_SURVEY_VALIDATION_REJECTION');
  } catch (error) {
    expect(error).toMatchObject({ status: 422, code: 'SURVEY_ANSWER_INVALID' });
  }
};

describe('DEV-68 required survey answer integrity', () => {
  it.each([
    { label: 'empty text', value: '' },
    { label: 'spaces', value: '  ' },
    { label: 'tab', value: '\t' },
    { label: 'line feed', value: '\n' },
  ])('rejects required text answer $label', ({ value }) => {
    invalid(q('text', true), value);
    invalid(q('textarea', true), value);
  });

  it('does not prohibit existing valid required text or optional blank responses', () => {
    expect(() => assertAnswerValue(q('text', true), 'Meaningful answer')).not.toThrow();
    expect(() => assertAnswerValue(q('textarea', true), ' Fine ')).not.toThrow();
    expect(() => assertAnswerValue(q('text', false), '')).not.toThrow();
    expect(() => assertAnswerValue(q('textarea', false), '  ')).not.toThrow();
  });

  it('rejects an empty multi-choice answer only when required', () => {
    invalid(q('multi_choice', true, ['Email', 'SMS']), []);
    expect(() => assertAnswerValue(q('multi_choice', false, ['Email', 'SMS']), []))
      .not.toThrow();
  });

  it('preserves valid choices and continues to reject duplicates or unknown choices', () => {
    expect(() => assertAnswerValue(q('multi_choice', true, ['Email', 'SMS']), ['Email']))
      .not.toThrow();
    expect(() => assertAnswerValue(q('multi_choice', true, ['Email', 'SMS']), ['Email', 'SMS']))
      .not.toThrow();
    invalid(q('multi_choice', true, ['Email', 'SMS']), ['Email', 'Email']);
    invalid(q('multi_choice', true, ['Email', 'SMS']), ['Unknown']);
  });

  it('does not conflate zero or false with a missing required response', () => {
    expect(() => assertAnswerValue(q('number', true), 0)).not.toThrow();
    expect(() => assertAnswerValue(q('boolean', true), false)).not.toThrow();
  });
});
