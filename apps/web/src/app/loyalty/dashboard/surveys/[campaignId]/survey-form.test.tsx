import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import type { SurveyQuestionDto } from '@echo-grid-feedback/shared-types';

vi.mock('@/lib/actions/surveys', () => ({ submitSurveyAction: vi.fn() }));

import { SurveyForm, buildAnswers, isAnswered } from './survey-form';

const q = (over: Partial<SurveyQuestionDto>): SurveyQuestionDto => ({
  id: '22222222-2222-4222-8222-222222222222',
  key: 'k',
  label: 'Question',
  type: 'text',
  required: false,
  position: 0,
  options: null,
  validation: null,
  ...over,
});

describe('survey form helpers', () => {
  it('isAnswered treats blank text and empty arrays as unanswered, false/0 as answered', () => {
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered('  ')).toBe(false);
    expect(isAnswered([])).toBe(false);
    expect(isAnswered(false)).toBe(true);
    expect(isAnswered(0)).toBe(true);
  });
  it('buildAnswers omits unanswered optional questions', () => {
    const a = q({ id: 'a' });
    const b = q({ id: 'b' });
    expect(buildAnswers([a, b], { a: 'hi' })).toEqual([{ questionId: 'a', value: 'hi' }]);
  });
});

describe('SurveyForm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps Submit disabled until consent is given and required questions are answered', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <SurveyForm
        campaignId="c"
        participationKey="participation-key-1234"
        questions={[q({ label: 'How was it?', type: 'single_choice', required: true, options: ['Good', 'Bad'] })]}
      />,
    );
    const submit = screen.getByRole('button', { name: 'Submit answers' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText('Good'));
    expect(submit).toBeDisabled(); // consent still missing
    await user.click(screen.getByLabelText(/I agree to share my answers/));
    expect(submit).toBeEnabled();
  });

  it('serializes typed answers into the hidden field (rating and boolean as real types)', async () => {
    const user = userEvent.setup();
    const { container } = renderWithIntl(
      <SurveyForm
        campaignId="c"
        participationKey="participation-key-1234"
        questions={[
          q({ id: 'r', label: 'Rate', type: 'rating', position: 0 }),
          q({ id: 'y', label: 'Return?', type: 'boolean', position: 1 }),
          q({ id: 'm', label: 'Pick', type: 'multi_choice', position: 2, options: ['A', 'B'] }),
        ]}
      />,
    );
    await user.click(screen.getAllByLabelText('4')[0]!);
    await user.click(screen.getByLabelText('Yes'));
    await user.click(screen.getByLabelText('A'));
    await user.click(screen.getByLabelText('B'));
    const hidden = container.querySelector('input[name="answers"]') as HTMLInputElement;
    expect(JSON.parse(hidden.value)).toEqual([
      { questionId: 'r', value: 4 },
      { questionId: 'y', value: true },
      { questionId: 'm', value: ['A', 'B'] },
    ]);
  });
});
