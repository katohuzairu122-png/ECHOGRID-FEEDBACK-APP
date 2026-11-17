import type {
  NetworkModerationHistoryAction,
  NetworkModerationHistoryPageDto,
} from '@echo-grid-feedback/shared-types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api-client';
import { getCurrentUser } from '@/lib/platform';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { canModerate, moderationPath } from '../moderation';

const historyPath = `${moderationPath}/history`;
const actionLabels: Record<NetworkModerationHistoryAction, string> = {
  'network.post_draft_created': 'Draft created',
  'network.post_draft_saved': 'Draft saved',
  'network.revision_submitted': 'Revision submitted',
  'network.revision_approved': 'Revision approved',
  'network.post_published': 'Post published',
  'network.revision_rejected': 'Revision rejected',
  'network.post_suspended': 'Post suspended',
  'network.post_lifted': 'Suspension lifted',
  'network.post_withdrawn': 'Post withdrawn',
  'network.post_pinned': 'Post pinned',
  'network.post_unpinned': 'Post unpinned',
};

export default async function ModerationHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string | string[] }>;
}) {
  if (!canModerate(await getCurrentUser())) notFound();

  const { cursor } = await searchParams;
  let history: NetworkModerationHistoryPageDto | undefined;
  if (!Array.isArray(cursor)) {
    try {
      const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor })}`;
      history = await apiFetch<NetworkModerationHistoryPageDto>(historyPath + query, {
        cache: 'no-store',
      });
    } catch (error) {
      rethrowControlFlow(error);
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) notFound();
    }
  }

  return (
    <section className="min-w-0 space-y-4">
      <Link className="underline" href={moderationPath}>
        Back to moderation
      </Link>
      <h1 className="text-xl font-semibold">Moderation history</h1>
      {!history ? (
        <p role="alert">
          Moderation history could not be loaded.{' '}
          <Link className="underline" href={historyPath}>
            Return to latest records
          </Link>
          .
        </p>
      ) : history.entries.length === 0 ? (
        <p>No moderation records on this page.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200">
          <table
            className="w-full text-start text-sm"
            aria-label="Moderation records, newest first"
          >
            <thead>
              <tr>
                {['Time (UTC)', 'Action', 'Status', 'Post handle', 'Moderator ID'].map((label) => (
                  <th key={label} scope="col" className="p-3 text-start">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.entries.map((entry, index) => (
                <tr key={index} className="border-t border-neutral-200">
                  <td className="whitespace-nowrap p-3">
                    <time dateTime={entry.occurredAt}>{entry.occurredAt}</time>
                  </td>
                  <td className="p-3">{actionLabels[entry.action]}</td>
                  <td className="p-3 capitalize">{entry.status.replaceAll('_', ' ')}</td>
                  <td className="p-3">
                    <code>{entry.postHandle ?? '—'}</code>
                  </td>
                  <td className="p-3">
                    <code>{entry.actorUserId ?? '—'}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(cursor !== undefined || history?.nextCursor) && (
        <nav className="flex flex-wrap gap-4" aria-label="Moderation history pages">
          {cursor !== undefined && history && (
            <Link className="underline" href={historyPath}>
              Latest records
            </Link>
          )}
          {history?.nextCursor && (
            <Link
              className="underline"
              href={`${historyPath}?${new URLSearchParams({ cursor: history.nextCursor })}`}
            >
              Older records
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}
