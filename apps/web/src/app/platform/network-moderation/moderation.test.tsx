import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/lib/api-error';
import { moderatePost } from './actions';
import { moderationPath } from './moderation';
import NetworkModerationPage from './page';
import { ModerationWorkspace } from './workspace';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  user: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn(() => {
    throw Object.assign(new Error('REDIRECT'), { digest: 'NEXT_REDIRECT' });
  }),
  notFound: vi.fn(() => {
    throw Error('NOT_FOUND');
  }),
}));
vi.mock('@/lib/api-client', async () => ({
  ...(await import('@/lib/api-error')),
  apiFetch: mocks.api,
}));
vi.mock('@/lib/platform', () => ({ getCurrentUser: mocks.user }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const admin = { platformRole: 'admin', impersonatedBy: null };
const handle = 'a'.repeat(22);
const revisionId = '12345678-1234-1234-1234-123456789abc';
const draftFields = { operation: 'create', body: 'Official news', locale: 'en' };
const pendingRevision = {
  revisionId,
  postHandle: handle,
  revisionNo: 3,
  body: 'Official news',
  contentLocale: 'en',
  linkUrl: 'https://example.test',
  submittedAt: null,
  approvals: 1,
};
function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue(admin);
  mocks.api.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('moderation server boundary', () => {
  it.each([
    null,
    { platformRole: null },
    { platformRole: 'support' },
    { platformRole: 'billing' },
    { ...admin, impersonatedBy: 'operator' },
  ])('denies the page and mutation for %j before calling moderation API', async (user) => {
    mocks.user.mockResolvedValue(user);
    await expect(NetworkModerationPage()).rejects.toThrow('NOT_FOUND');
    await expect(moderatePost({}, form(draftFields))).resolves.toHaveProperty('error');
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('loads the enabled queue for an administrator and never caches it', async () => {
    mocks.api.mockResolvedValue([]);
    expect(await NetworkModerationPage()).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith(moderationPath + '/queue', {
      cache: 'no-store',
    });
  });

  it('preserves the flag-off 404 for a platform admin', async () => {
    mocks.api.mockRejectedValue(new ApiError('Not found.', 404, 'NOT_FOUND'));
    await expect(NetworkModerationPage()).rejects.toThrow('NOT_FOUND');
    await expect(moderatePost({}, form(draftFields))).resolves.toHaveProperty('error');
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each([new ApiError('private database detail', 503), new Error('private transport detail')])(
    'offers safe temporary queue recovery without an empty-queue claim or mutation controls',
    async (error) => {
      mocks.api.mockRejectedValue(error);
      render(await NetworkModerationPage());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Pending approval queue could not be loaded',
      );
      expect(screen.queryByText(/private/)).not.toBeInTheDocument();
      expect(screen.queryByText('No revisions are awaiting review.')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve revision' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Moderation history' })).toHaveAttribute(
        'href',
        moderationPath + '/history',
      );
      expect(screen.getByRole('link', { name: 'Saved drafts' })).toHaveAttribute(
        'href',
        moderationPath + '/drafts',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
      expect(mocks.refresh).toHaveBeenCalledOnce();
      expect(mocks.api).toHaveBeenCalledExactlyOnceWith(moderationPath + '/queue', {
        cache: 'no-store',
      });
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])('preserves queue API access denial (%s)', async (status) => {
    mocks.api.mockRejectedValue(new ApiError('private', status));
    await expect(NetworkModerationPage()).rejects.toThrow('NOT_FOUND');
  });

  it.each([400, 429])(
    'leaves non-temporary queue errors on the existing error boundary (%s)',
    async (status) => {
      const error = new ApiError('private', status);
      mocks.api.mockRejectedValue(error);
      await expect(NetworkModerationPage()).rejects.toBe(error);
    },
  );

  it('preserves redirect control flow and distinguishes a genuine empty queue', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/login;307;',
    });
    mocks.api.mockRejectedValueOnce(redirect);
    await expect(NetworkModerationPage()).rejects.toBe(redirect);
    mocks.api.mockResolvedValueOnce([]);
    render(await NetworkModerationPage());
    expect(screen.getByText('No revisions are awaiting review.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry loading' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeEnabled();
  });

  it('creates, edits, and submits through the existing draft APIs', async () => {
    mocks.api
      .mockResolvedValueOnce({ handle })
      .mockResolvedValueOnce({ revisionNo: 2 })
      .mockResolvedValueOnce({ status: 'submitted' });
    await expect(moderatePost({}, form(draftFields))).resolves.toHaveProperty('handle', handle);
    await expect(
      moderatePost({}, form({ ...draftFields, operation: 'save', target: handle })),
    ).resolves.toHaveProperty('handle', handle);
    await expect(
      moderatePost({}, form({ operation: 'submit', target: handle })),
    ).resolves.toHaveProperty('notice');
    expect(mocks.api.mock.calls).toEqual([
      [
        moderationPath + '/posts',
        {
          method: 'POST',
          body: JSON.stringify({ body: 'Official news', contentLocale: 'en', linkUrl: null }),
        },
      ],
      [
        moderationPath + '/posts/' + handle + '/draft',
        {
          method: 'PUT',
          body: JSON.stringify({ body: 'Official news', contentLocale: 'en', linkUrl: null }),
        },
      ],
      [moderationPath + '/posts/' + handle + '/submit', { method: 'POST' }],
    ]);
  });

  it.each([
    { ...draftFields, body: 'a'.repeat(2001) },
    { ...draftFields, link: 'http://example.test' },
    { operation: 'approve', target: '../posts' },
    { operation: 'reject', target: revisionId, reason: 'private note' },
    { operation: 'withdraw', target: handle },
  ])('rejects invalid or unconfirmed requests', async (fields) => {
    await expect(moderatePost({}, form(fields as Record<string, string>))).resolves.toHaveProperty(
      'error',
    );
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('returns a successfully submitted saved draft to the queue without swallowing the redirect', async () => {
    mocks.api.mockResolvedValue({ status: 'submitted' });
    await expect(
      moderatePost({}, form({ operation: 'submit', target: handle, returnToQueue: 'on' })),
    ).rejects.toThrow('REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(moderationPath);
  });

  it('reports the first approval without implying publication', async () => {
    mocks.api.mockResolvedValue({ status: 'recorded', approvals: 1, required: 2 });
    const result = await moderatePost({}, form({ operation: 'approve', target: revisionId }));
    expect(result).toEqual({ notice: 'Approval recorded (1 of 2).' });
  });

  it.each([403, 409])(
    'reports API denial or stale state (%s) without false success',
    async (status) => {
      mocks.api.mockRejectedValue(new ApiError('Internal detail', status));
      const result = await moderatePost({}, form({ operation: 'approve', target: revisionId }));
      expect(result.error).toBeTruthy();
      expect(result.error).not.toContain('Internal detail');
      expect(result.notice).toBeUndefined();
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );

  it('routes approved rejection and suspension reasons to their own targets', async () => {
    mocks.api.mockResolvedValueOnce({ status: 'rejected' }).mockResolvedValueOnce({
      handle,
      state: 'suspended',
      pinned: false,
      expiresAt: '2025-01-01T00:00:00Z',
    });
    const reason = 'unsafe_link';
    await expect(
      moderatePost({}, form({ operation: 'reject', target: revisionId, reason })),
    ).resolves.toHaveProperty('notice', 'Revision rejected.');
    await expect(
      moderatePost({}, form({ operation: 'suspend', target: handle, reason, confirm: 'on' })),
    ).resolves.toHaveProperty('post.state', 'suspended');
    expect(mocks.api.mock.calls).toEqual([
      [
        moderationPath + '/revisions/' + revisionId + '/reject',
        { method: 'POST', body: '{"reasonCode":"unsafe_link"}' },
      ],
      [
        moderationPath + '/posts/' + handle + '/suspend',
        { method: 'POST', body: '{"reasonCode":"unsafe_link"}' },
      ],
    ]);
  });
});

describe('moderation workspace', () => {
  it('presents the queue, visible progress, labels, and keyboard access without activating proposed links', async () => {
    render(<ModerationWorkspace queue={[pendingRevision]} />);
    expect(screen.getByRole('heading', { name: 'Pending approval' })).toBeVisible();
    expect(screen.getByText('1 of 2 approvals')).toBeVisible();
    expect(screen.getByText('https://example.test')).toBeVisible();
    expect(screen.queryByRole('link', { name: /example/ })).toBeNull();
    expect(screen.getByLabelText('Post text')).toBeVisible();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Approve revision' })).toHaveFocus();
    await user.tab();
    expect(screen.getAllByLabelText('Moderation reason')[0]).toHaveFocus();
  });

  it('submits the selected pending revision by keyboard and announces the result', async () => {
    mocks.api.mockResolvedValue({ status: 'recorded', approvals: 1, required: 2 });
    render(<ModerationWorkspace queue={[pendingRevision]} />);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('status')).toHaveTextContent('Approval recorded (1 of 2).');
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith(
      moderationPath + '/revisions/' + revisionId + '/approve',
      { method: 'POST' },
    );
  });

  it('presents an empty queue and keeps authoring independently available', () => {
    render(<ModerationWorkspace queue={[]} />);
    expect(screen.getByText('No revisions are awaiting review.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeEnabled();
  });
});
