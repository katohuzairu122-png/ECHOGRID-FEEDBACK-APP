import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import arabic from '../../../../../messages/ar/feedback.json';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils';
import { FormBuilder } from './form-builder';

const actions = vi.hoisted(() => ({ create: vi.fn(), version: vi.fn() }));
vi.mock('@/lib/actions/feedback-forms', () => ({
  createFeedbackFormAction: actions.create,
  createFeedbackFormVersionAction: actions.version,
}));

describe('feedback form quick setup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes from the form name and question text using the existing defaults', async () => {
    const user = userEvent.setup();
    renderWithIntl(<FormBuilder />);
    expect(screen.getByLabelText('Question key')).not.toBeVisible();
    await user.type(screen.getByLabelText('Form name'), 'Visit');
    await user.type(screen.getByLabelText('Question text'), 'How was your visit?');
    await user.click(screen.getByRole('button', { name: 'Publish form' }));
    expect(actions.create).toHaveBeenCalledWith({
      name: 'Visit',
      questions: [
        { key: 'experience', label: 'How was your visit?', type: 'textarea', required: true },
      ],
    });
  });

  it('retains advanced settings and validates choice options when publishing a version', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <FormBuilder
        formId="form-1"
        initialName="Visit"
        initialQuestions={[
          { key: 'channel', label: 'Order type', type: 'single_choice', required: false },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Publish new version' }));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(actions.version).not.toHaveBeenCalled();

    await user.click(screen.getByText('Question settings'));
    await user.type(screen.getByLabelText('Options (comma separated)'), 'Pickup, Delivery');
    await user.click(screen.getByLabelText('Required'));
    await user.click(screen.getByRole('button', { name: 'Publish new version' }));
    expect(actions.version).toHaveBeenCalledWith('form-1', {
      name: 'Visit',
      questions: [
        {
          key: 'channel',
          label: 'Order type',
          type: 'single_choice',
          required: true,
          options: ['Pickup', 'Delivery'],
        },
      ],
    });
  });

  it('provides Arabic labels when rendered in an RTL layout', () => {
    render(
      <NextIntlClientProvider locale="ar" timeZone="UTC" messages={{ feedback: arabic }}>
        <div dir="rtl">
          <FormBuilder />
        </div>
      </NextIntlClientProvider>,
    );
    expect(screen.getByLabelText('اسم النموذج').closest('[dir]')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByLabelText('نص السؤال')).toBeRequired();
    expect(screen.getByRole('button', { name: 'نشر النموذج' })).toBeInTheDocument();
  });

  it('uses unique keys after removing and adding questions', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <FormBuilder
        initialName="Visit"
        initialQuestions={[
          { key: 'question_2', label: 'First', type: 'text', required: false },
          { key: 'question_3', label: 'Second', type: 'text', required: false },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove question 1' }));
    await user.click(screen.getByRole('button', { name: 'Add question' }));
    await user.type(screen.getAllByLabelText('Question text')[1]!, 'New question');
    await user.click(screen.getByRole('button', { name: 'Publish form' }));
    expect(
      actions.create.mock.lastCall?.[0].questions.map(({ key }: { key: string }) => key),
    ).toEqual(['question_3', 'question_2']);
  });
});
