import {
  NETWORK_DRAFT_HANDLE,
  type NetworkSavedDraftDto,
  type NetworkSavedDraftPageDto,
} from '@echo-grid-feedback/shared-types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api-client';
import { getCurrentUser } from '@/lib/platform';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { canModerate, moderationPath } from '../moderation';
import { Authoring } from '../workspace';
import { isTemporaryReadFailure } from '../read-failure';
import { ModerationReadRetry } from '../read-retry';

const draftsPath = `${moderationPath}/drafts`;

function draftPageHref(cursor?: string, handle?: string) {
  const query = new URLSearchParams();
  if (cursor !== undefined) query.set('cursor', cursor);
  if (handle !== undefined) query.set('draft', handle);
  return query.size ? `${draftsPath}?${query}` : draftsPath;
}

export default async function SavedDraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string | string[]; draft?: string | string[] }>;
}) {
  if (!canModerate(await getCurrentUser())) notFound();

  const { cursor, draft } = await searchParams;
  const position = typeof cursor === 'string' ? cursor : undefined;
  let page: NetworkSavedDraftPageDto | undefined;
  let selected: NetworkSavedDraftDto | undefined;
  let retryListing = false;
  let retrySelection = false;
  if (!Array.isArray(cursor)) {
    try {
      page = await apiFetch<NetworkSavedDraftPageDto>(draftPageHref(position), {
        cache: 'no-store',
      });
    } catch (error) {
      rethrowControlFlow(error);
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) notFound();
      retryListing = isTemporaryReadFailure(error);
    }
  }
  if (page && typeof draft === 'string' && NETWORK_DRAFT_HANDLE.test(draft)) {
    try {
      selected = await apiFetch<NetworkSavedDraftDto>(`${draftsPath}/${draft}`, {
        cache: 'no-store',
      });
    } catch (error) {
      rethrowControlFlow(error);
      if (error instanceof ApiError && [401, 403].includes(error.status)) notFound();
      retrySelection = isTemporaryReadFailure(error);
    }
  }

  return (
    <section className="space-y-5">
      <Link className="underline" href={moderationPath}>
        Back to moderation
      </Link>
      <h1 className="text-2xl font-semibold">Saved drafts</h1>
      {!page ? (
        <p role="alert">
          Saved drafts could not be loaded.{' '}
          <Link className="underline" href={draftsPath}>
            Return to the first page
          </Link>
          .{retryListing && <ModerationReadRetry />}
        </p>
      ) : (
        <>
          {page.entries.length === 0 ? (
            <p>No editable drafts on this page.</p>
          ) : (
            <ul className="space-y-3">
              {page.entries.map((entry) => (
                <li
                  key={entry.handle}
                  className="min-w-0 space-y-1 rounded-xl border border-neutral-200 p-4"
                >
                  <Link
                    className="underline"
                    href={draftPageHref(position, entry.handle)}
                    aria-current={selected?.handle === entry.handle ? 'true' : undefined}
                  >
                    Open draft <code>{entry.handle}</code>
                  </Link>
                  <p className="break-words">{entry.preview}</p>
                  <p className="text-sm text-neutral-600">
                    {entry.lastSavedAt ? 'Last saved' : 'Created'}{' '}
                    <time dateTime={entry.lastSavedAt ?? entry.createdAt}>
                      {entry.lastSavedAt ?? entry.createdAt}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {(position !== undefined || page.nextCursor) && (
            <nav className="flex flex-wrap gap-4" aria-label="Saved draft pages">
              {position !== undefined && (
                <Link className="underline" href={draftPageHref(undefined, selected?.handle)}>
                  First page
                </Link>
              )}
              {page.nextCursor && (
                <Link className="underline" href={draftPageHref(page.nextCursor, selected?.handle)}>
                  Next page
                </Link>
              )}
            </nav>
          )}
          {selected ? (
            <Authoring key={selected.handle} initialDraft={selected} />
          ) : (
            draft !== undefined && (
              <p role="alert">
                This saved draft is unavailable.
                {retrySelection && <ModerationReadRetry />}
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}
