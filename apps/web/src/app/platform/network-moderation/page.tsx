import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api-client';
import { getCurrentUser } from '@/lib/platform';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { canModerate, moderationPath, type PendingRevision } from './moderation';
import { ModerationWorkspace } from './workspace';
import { isTemporaryReadFailure } from './read-failure';
import { ModerationReadRetry } from './read-retry';

export default async function NetworkModerationPage() {
  if (!canModerate(await getCurrentUser())) notFound();
  let queue: PendingRevision[] | undefined;
  try {
    queue = await apiFetch<PendingRevision[]>(`${moderationPath}/queue`, { cache: 'no-store' });
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) notFound();
    if (!isTemporaryReadFailure(error)) throw error;
  }
  return (
    <div className="space-y-4">
      <Link className="underline" href={`${moderationPath}/history`}>
        Moderation history
      </Link>
      {queue === undefined ? (
        <section className="space-y-4" aria-labelledby="queue-unavailable-title">
          <h1 className="text-2xl font-semibold">Community moderation</h1>
          <h2 id="queue-unavailable-title" className="text-lg font-semibold">
            Pending approval
          </h2>
          <p role="alert">Pending approval queue could not be loaded.</p>
          <ModerationReadRetry />
          <p>
            <Link className="underline" href={`${moderationPath}/drafts`}>
              Saved drafts
            </Link>
          </p>
        </section>
      ) : (
        <ModerationWorkspace queue={queue} />
      )}
    </div>
  );
}
