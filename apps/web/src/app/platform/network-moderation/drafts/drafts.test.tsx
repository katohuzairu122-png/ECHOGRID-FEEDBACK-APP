import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-error';
import LoadingSavedDrafts from './loading';
import SavedDraftsPage from './page';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
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
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
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
});
