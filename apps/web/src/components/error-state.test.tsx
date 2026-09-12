import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import { ErrorState } from './error-state';

/**
 * The body all five error boundaries render (app/error.tsx and the three
 * segment boundaries via this component; global-error.tsx is deliberately
 * standalone -- it runs with no intl provider, so it cannot use this).
 *
 * Vitest cannot render the error.tsx files themselves: Next constructs those
 * boundaries, and the segment layouts around them are async Server
 * Components, which this tier structurally cannot render (see
 * vitest.config.ts). So this tests the part that holds the behaviour, and
 * the boundary files are four lines of delegation each.
 */
describe('ErrorState', () => {
  const anError = () => new Error('Upstream API returned 500');

  it('shows a recovery message rather than the raw error', () => {
    renderWithIntl(<ErrorState error={anError()} reset={vi.fn()} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // The thrown message is never surfaced. In production Next replaces it
    // with a generic string anyway, so rendering it would show one thing in
    // development and another in production -- and could leak an internal
    // detail in the window before it does.
    expect(screen.queryByText(/Upstream API returned 500/)).not.toBeInTheDocument();
  });

  it('calls reset when the retry button is pressed', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    renderWithIntl(<ErrorState error={anError()} reset={reset} />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('shows the digest so a user can quote it to support', () => {
    // Currently the only handle correlating what a user saw with what the
    // Worker logged -- there is no error reporting on the platform yet
    // (audit P3-2).
    const error = Object.assign(anError(), { digest: '2718281828' });
    renderWithIntl(<ErrorState error={error} reset={vi.fn()} />);

    expect(screen.getByText(/2718281828/)).toBeInTheDocument();
  });

  it('omits the reference line entirely when there is no digest', () => {
    // Rather than rendering "Reference undefined", which is what a naive
    // template interpolation produces.
    renderWithIntl(<ErrorState error={anError()} reset={vi.fn()} />);

    expect(screen.queryByText(/Reference/)).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('keeps the retry control reachable by keyboard', () => {
    // The only control on the page. If it is not focusable, a keyboard or
    // screen-reader user has no recovery path at all from here.
    renderWithIntl(<ErrorState error={anError()} reset={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Retry' });
    button.focus();
    expect(button).toHaveFocus();
  });
});
