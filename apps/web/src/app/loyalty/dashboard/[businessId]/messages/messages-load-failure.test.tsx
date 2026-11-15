import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils';
import { ApiError } from '@/lib/api-error';
import CustomerMessagesPage from './page';

const { fetchThread, refresh } = vi.hoisted(() => ({ fetchThread: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('next-intl/server', async () => {
  const { default: loyalty } = await import('../../../../../../messages/en/loyalty.json');
  return {
    getFormatter: async () => ({ dateTime: () => 'Today' }),
    getTranslations: async () => (key: keyof typeof loyalty.customer.messages) =>
      loyalty.customer.messages[key],
  };
});
vi.mock('@/lib/customer-api-client', () => ({ customerApiFetch: fetchThread }));
vi.mock('./reply-form', () => ({ ReplyForm: () => <form aria-label="Reply" /> }));

const page = () =>
  CustomerMessagesPage({
    params: Promise.resolve({ businessId: 'business-1' }),
    searchParams: Promise.resolve({ offset: '100' }),
  });

describe('customer Messages inline recovery', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());

  it.each([new ApiError('upstream', 503), new TypeError('network')])(
    'offers manual retry for %s',
    async (error) => {
      fetchThread.mockRejectedValueOnce(error);
      renderWithIntl(await page());
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load messages');
      expect(screen.queryByRole('form', { name: 'Reply' })).not.toBeInTheDocument();
      expect(fetchThread).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();

      let finish!: () => void;
      refresh.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      const pending = screen.getByRole('button', { name: 'Retrying…' });
      expect(pending).toBeDisabled();
      fireEvent.click(pending);
      expect(refresh).toHaveBeenCalledTimes(1);
      await act(async () => finish());
    },
  );

  it('waits one limiter window and does not retry automatically', async () => {
    vi.useFakeTimers();
    fetchThread.mockRejectedValueOnce(new ApiError('limited', 429));
    renderWithIntl(await page());
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeDisabled();
    act(() => vi.advanceTimersByTime(59_000));
    expect(retry).toBeDisabled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(retry).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    new ApiError('unauthenticated', 401),
    new ApiError('forbidden', 403),
    new Error('NEXT_REDIRECT'),
  ])('passes %s through to the existing redirect or error boundary', async (error) => {
    fetchThread.mockRejectedValueOnce(error);
    await expect(page()).rejects.toBe(error);
    expect(fetchThread.mock.lastCall?.[2]).toBe(
      '/loyalty/dashboard/business-1/messages?offset=100',
    );
  });

  it('preserves the no-conversation state', async () => {
    fetchThread.mockRejectedValueOnce(new ApiError('missing', 404));
    renderWithIntl(await page());
    expect(screen.getByText('No messages yet')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('does not render stale messages or a reply form when the history load fails', async () => {
    fetchThread
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError('unavailable', 500));
    renderWithIntl(await page());
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Reply' })).not.toBeInTheDocument();
    expect(fetchThread).toHaveBeenCalledTimes(3);
    expect(fetchThread.mock.lastCall?.[0]).toContain('offset=100');
  });
});
