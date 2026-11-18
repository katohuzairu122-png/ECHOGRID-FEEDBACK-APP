import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-error';
import LoadingSavedDrafts from './loading';
import SavedDraftsPage from './page';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  user: vi.fn(),
  action: vi.fn(),
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
vi.mock('../actions', () => ({ moderatePost: mocks.action }));

const admin = { platformRole: 'admin', impersonatedBy: null };
const path = '/platform/network-moderation/drafts';
const handle = 'A'.repeat(22);
const page = (params: { cursor?: string | string[]; draft?: string | string[] } = {}) =>
  SavedDraftsPage({ searchParams: Promise.resolve(params) });
const listing = {
  entries: [
    {
      handle,
      preview: 'Saved preview',
      createdAt: '2026-11-17T12:00:00.000Z',
      lastSavedAt: '2026-11-17T12:01:00.000Z',
    },
  ],
  nextCursor: 'next-cursor',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue(admin);
});

describe('saved drafts workspace', () => {
  it.each([
    null,
    { platformRole: null },
    { platformRole: 'billing' },
    { ...admin, impersonatedBy: 'actor' },
  ])('denies %j before the API is called', async (user) => {
    mocks.user.mockResolvedValue(user);
    await expect(page()).rejects.toThrow('NOT_FOUND');
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('shows previews, last-saved evidence, and bounded navigation with uncached reads', async () => {
    mocks.api.mockResolvedValue(listing);
    render(await page({ cursor: 'previous-cursor' }));
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith(path + '?cursor=previous-cursor', {
      cache: 'no-store',
    });
    expect(screen.getByText('Saved preview')).toBeVisible();
    expect(screen.getByText('2026-11-17T12:01:00.000Z')).toBeVisible();
    expect(screen.getByRole('link', { name: /Open draft/ })).toHaveAttribute(
      'href',
      `${path}?cursor=previous-cursor&draft=${handle}`,
    );
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      path + '?cursor=next-cursor',
    );
  });

  it('loads the selected draft into the existing authoring form without saving or submitting', async () => {
    mocks.api.mockResolvedValueOnce(listing).mockResolvedValueOnce({
      handle,
      body: 'Full draft',
      contentLocale: 'ar',
      linkUrl: 'https://example.test',
    });
    render(await page({ draft: handle }));
    expect(mocks.api).toHaveBeenLastCalledWith(`${path}/${handle}`, { cache: 'no-store' });
    expect(screen.getByLabelText('Post text')).toHaveValue('Full draft');
    expect(screen.getByLabelText('Content language')).toHaveValue('ar');
    expect(screen.getByLabelText('HTTPS link (optional)')).toHaveValue('https://example.test');
    expect(screen.getByLabelText('Existing post handle')).toHaveValue(handle);
    expect(screen.getByLabelText('Existing post handle')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Saved draft handle')).toHaveValue(handle);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('shows loading, empty, and sanitized error states', async () => {
    mocks.api.mockResolvedValueOnce({ entries: [], nextCursor: null });
    render(<LoadingSavedDrafts />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading saved drafts');
    render(await page());
    expect(screen.getByText('No editable drafts on this page.')).toBeVisible();
    mocks.api.mockRejectedValueOnce(new ApiError('private details', 500));
    render(await page());
    expect(screen.getByRole('alert')).toHaveTextContent('Saved drafts could not be loaded.');
    expect(screen.queryByText('private details')).not.toBeInTheDocument();
  });

  it('does not request a malformed selection and leaves the list usable for a missing draft', async () => {
    mocks.api.mockResolvedValue(listing);
    const view = render(await page({ draft: '../private' }));
    expect(mocks.api).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toHaveTextContent('This saved draft is unavailable.');
    mocks.api.mockResolvedValueOnce(listing).mockRejectedValueOnce(new ApiError('Not found', 404));
    view.rerender(await page({ draft: handle }));
    expect(screen.getByRole('alert')).toHaveTextContent('This saved draft is unavailable.');
    expect(screen.getByText('Saved preview')).toBeVisible();
  });
  it('retries a temporary listing failure without saving or submitting', async () => {
    mocks.api.mockRejectedValue(new ApiError('private list detail', 503));
    render(await page({ cursor: 'position', draft: handle }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith(path + '?cursor=position', {
      cache: 'no-store',
    });
    expect(mocks.action).not.toHaveBeenCalled();
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  });

  it('offers retry for a temporary selection failure while keeping its listing usable', async () => {
    mocks.api
      .mockResolvedValueOnce(listing)
      .mockRejectedValueOnce(new Error('private upstream detail'));
    render(await page({ cursor: 'position', draft: handle }));
    expect(screen.getByText('Saved preview')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Post text')).not.toBeInTheDocument();
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  });

  it.each([400, 404, 429])(
    'does not retry missing, invalid or rate-limited draft selection (%s)',
    async (status) => {
      mocks.api
        .mockResolvedValueOnce(listing)
        .mockRejectedValueOnce(new ApiError('private', status));
      render(await page({ draft: handle }));
      expect(screen.queryByRole('button', { name: 'Retry loading' })).not.toBeInTheDocument();
    },
  );

  it.each([401, 403])('preserves selection denial (%s)', async (status) => {
    mocks.api.mockResolvedValueOnce(listing).mockRejectedValueOnce(new ApiError('private', status));
    await expect(page({ draft: handle })).rejects.toThrow('NOT_FOUND');
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('does not retry a repeated cursor or swallow a redirect', async () => {
    render(await page({ cursor: ['one', 'two'] }));
    expect(mocks.api).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Retry loading' })).not.toBeInTheDocument();
    const error = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/login;307;',
    });
    mocks.api.mockRejectedValue(error);
    await expect(page()).rejects.toBe(error);
  });
});
