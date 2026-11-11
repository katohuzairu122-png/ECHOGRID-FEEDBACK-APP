import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import { classifyMessagesError } from './messages-error';
import { MessagesFailureNotice } from './messages-failure-notice';

describe('classifyMessagesError', () => {
  it('sends an expired session to login, tells a denial from an outage, and treats anything else as unavailable', () => {
    expect(classifyMessagesError({ status: 401 })).toBe('login');
    expect(classifyMessagesError({ status: 403 })).toBe('forbidden');
    for (const e of [
      { status: 500 },
      { status: 429 },
      { status: 404 },
      new Error('network down'),
      null,
      undefined,
      'x',
    ]) {
      expect(classifyMessagesError(e)).toBe('unavailable');
    }
  });
});

describe('MessagesFailureNotice', () => {
  it('shows an alert with a retry link when the list is unavailable, never the empty-state text', () => {
    renderWithIntl(<MessagesFailureNotice kind="unavailable" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Messages could not be loaded');
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/dashboard/messages',
    );
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
  });

  it('shows a denial without a retry link', () => {
    renderWithIntl(<MessagesFailureNotice kind="forbidden" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Messages are not available with your current access',
    );
    expect(screen.queryByRole('link', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
