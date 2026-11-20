import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils';
import { SignupForm as SignupPage } from './signup-form';

vi.mock('@/lib/actions/auth', () => ({ signupAction: vi.fn() }));

it('keeps the signup inputs available and hides the decorative watermark from assistive technology', () => {
  const { container } = renderWithIntl(<SignupPage />);
  const layer = container.querySelector('main > div[aria-hidden="true"]');
  expect(layer?.querySelector('svg')).toBeInTheDocument();
  expect(layer).toHaveClass('pointer-events-none');
  for (const field of ['Full name', 'Email', 'Password']) {
    expect(screen.getByLabelText(field)).toBeRequired();
  }
});
