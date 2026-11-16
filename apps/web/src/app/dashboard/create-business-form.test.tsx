import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';

vi.mock('@/lib/actions/business', () => ({ createBusinessAction: vi.fn() }));

import { createBusinessAction } from '@/lib/actions/business';
import { CreateBusinessForm } from './create-business-form';

describe('CreateBusinessForm (ONBOARDING-UX-01)', () => {
  it('asks only for the business name: there is no URL slug field', () => {
    renderWithIntl(<CreateBusinessForm />);
    expect(screen.getByLabelText('Business name')).toBeRequired();
    expect(screen.queryByLabelText(/slug|url name|web address/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[name="slug"]')).toBeNull();
  });

  it('submits just the name and shows the specific error the action returns, keeping the typed name', async () => {
    vi.mocked(createBusinessAction).mockResolvedValue({
      error: 'We could not create your business, so nothing was saved. Please try again.',
    });
    renderWithIntl(<CreateBusinessForm />);
    await userEvent.setup().type(screen.getByLabelText('Business name'), 'Joe Cafe');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create business' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was saved');
    const submitted = vi.mocked(createBusinessAction).mock.calls[0]![1] as FormData;
    expect(submitted.get('name')).toBe('Joe Cafe');
    expect(submitted.has('slug')).toBe(false);
  });
});
