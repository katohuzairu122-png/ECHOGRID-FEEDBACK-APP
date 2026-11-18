import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-error';
import LoadingModerationHistory from './loading';
import ModerationHistoryPage from './page';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  user: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('@/lib/api-client', async () => ({
  ...(await import('@/lib/api-error')),
  apiFetch: mocks.api,
}));
vi.mock('@/lib/platform', () => ({ getCurrentUser: mocks.user }));
vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const admin = { platformRole: 'admin', impersonatedBy: null };
const historyPath = '/platform/network-moderation/history';
const cursor = '11111111-1111-4111-8111-111111111111';
const page = (params: { cursor?: string | string[] } = {}) =>
  ModerationHistoryPage({ searchParams: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockReset();
  mocks.user.mockResolvedValue(admin);
});

describe('platform moderation history page', () => {
  it.each([null, { platformRole: null }, { ...admin, impersonatedBy: cursor }])(
    'checks authorization before calling API for %j',
    async (user) => {
      mocks.user.mockResolvedValue(user);
      await expect(page()).rejects.toThrow('NOT_FOUND');
      expect(mocks.api).not.toHaveBeenCalled();
    },
  );

  it('displays the closed page fields and uses the returned cursor for older records', async () => {
    mocks.api.mockResolvedValue({
      entries: [
        {
          occurredAt: '2026-11-17T12:00:00.000Z',
          action: 'network.revision_approved',
          status: 'approval_recorded',
          postHandle: 'A'.repeat(22),
          actorUserId: cursor,
        },
      ],
      nextCursor: cursor,
    });
    render(await page({ cursor }));
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith(`${historyPath}?cursor=${cursor}`, {
      cache: 'no-store',
    });
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.getByText('Revision approved')).toBeVisible();
    expect(screen.getByText('approval recorded')).toBeVisible();
    expect(screen.getByText('A'.repeat(22))).toBeVisible();
    expect(screen.getByText(cursor)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Older records' })).toHaveAttribute(
      'href',
      `${historyPath}?cursor=${cursor}`,
    );
    expect(screen.getByRole('link', { name: 'Latest records' })).toHaveAttribute(
      'href',
      historyPath,
    );
  });

  it('renders loading and empty states without advertising a next page', async () => {
    mocks.api.mockResolvedValue({ entries: [], nextCursor: null });
    render(<LoadingModerationHistory />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading moderation history');
    render(await page());
    expect(screen.getByText('No moderation records on this page.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Older records' })).not.toBeInTheDocument();
  });

  it('renders a safe error when the API fails', async () => {
    mocks.api.mockRejectedValue(new ApiError('SQL internals', 500));
    render(await page());
    expect(screen.getByRole('alert')).toHaveTextContent('Moderation history could not be loaded');
    expect(screen.queryByText('SQL internals')).not.toBeInTheDocument();
  });

  it('preserves denied or disabled API responses and rejects repeated cursors', async () => {
    for (const status of [401, 403, 404]) {
      mocks.api.mockRejectedValueOnce(new ApiError('Unavailable', status));
      await expect(page()).rejects.toThrow('NOT_FOUND');
    }
    mocks.api.mockClear();
    render(await page({ cursor: [cursor, cursor] }));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it.each([new ApiError('private', 503), new Error('private network detail')])(
    'retries a temporary failure on the current cursor without exposing details',
    async (error) => {
      mocks.api.mockRejectedValue(error);
      render(await page({ cursor }));
      fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
      expect(mocks.refresh).toHaveBeenCalledOnce();
      expect(mocks.api).toHaveBeenCalledExactlyOnceWith(`${historyPath}?cursor=${cursor}`, {
        cache: 'no-store',
      });
      expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    },
  );

  it.each([400, 429])(
    'does not advertise a temporary-error retry for status %s',
    async (status) => {
      mocks.api.mockRejectedValue(new ApiError('private', status));
      render(await page({ cursor }));
      expect(screen.queryByRole('button', { name: 'Retry loading' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Return to latest records' })).toHaveAttribute(
        'href',
        historyPath,
      );
    },
  );

  it('preserves redirect control flow instead of showing a retry', async () => {
    const error = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/login;307;',
    });
    mocks.api.mockRejectedValue(error);
    await expect(page()).rejects.toBe(error);
  });
});
