import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderWithIntl, screen } from '@/test-utils';
import { resetUnreadStoreForTests } from '@/lib/unread-store';
import { NavUnreadBadge, NavUnreadDot } from './nav-unread-badge';

const answer = (staff: number, customer = 0) =>
  vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({ unreadMessages: url.includes('messaging') ? staff : customer }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
  );

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  resetUnreadStoreForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NavUnreadBadge', () => {
  it('shows the count and gives screen readers one sentence instead of the number', async () => {
    vi.stubGlobal('fetch', answer(3));
    const { container } = renderWithIntl(<NavUnreadBadge source="staff-messages" />);
    await settle();
    const pill = container.querySelector('[data-unread-badge]');
    expect(pill).toHaveTextContent('3');
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('3 unread messages')).toHaveClass('sr-only');
  });

  it('uses the singular for one', async () => {
    vi.stubGlobal('fetch', answer(1));
    renderWithIntl(<NavUnreadBadge source="staff-messages" />);
    await settle();
    expect(screen.getByText('1 unread message')).toBeInTheDocument();
  });

  it('caps the visible number at 99+ but keeps the real count for screen readers', async () => {
    vi.stubGlobal('fetch', answer(250));
    const { container } = renderWithIntl(<NavUnreadBadge source="staff-messages" />);
    await settle();
    expect(container.querySelector('[data-unread-badge]')).toHaveTextContent('99+');
    expect(screen.getByText('250 unread messages')).toBeInTheDocument();
  });

  it('renders nothing at zero', async () => {
    vi.stubGlobal('fetch', answer(0));
    const { container } = renderWithIntl(<NavUnreadBadge source="staff-messages" />);
    await settle();
    expect(container.querySelector('[data-unread-badge]')).toBeNull();
    expect(screen.queryByText(/unread/)).toBeNull();
  });
});

describe('NavUnreadDot', () => {
  it('appears on the More button when a hidden item has unread messages', async () => {
    vi.stubGlobal('fetch', answer(0, 4));
    const { container } = renderWithIntl(<NavUnreadDot sources={['customer-messages']} />);
    await settle();
    expect(container.querySelector('[data-unread-dot]')).not.toBeNull();
    expect(screen.getByText('4 unread messages')).toBeInTheDocument();
  });

  it('stays hidden when nothing is unread', async () => {
    vi.stubGlobal('fetch', answer(0, 0));
    const { container } = renderWithIntl(<NavUnreadDot sources={['customer-messages']} />);
    await settle();
    expect(container.querySelector('[data-unread-dot]')).toBeNull();
  });
});
