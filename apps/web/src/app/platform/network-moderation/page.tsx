import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api-client';
import { getCurrentUser } from '@/lib/platform';
import { canModerate, moderationPath, type PendingRevision } from './moderation';
import { ModerationWorkspace } from './workspace';

export default async function NetworkModerationPage() {
  if (!canModerate(await getCurrentUser())) notFound();
  let queue: PendingRevision[];
  try {
    queue = await apiFetch<PendingRevision[]>(`${moderationPath}/queue`, { cache: 'no-store' });
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) notFound();
    throw error;
  }
  return (
    <div className="space-y-4">
      <Link className="underline" href={`${moderationPath}/history`}>
        Moderation history
      </Link>
      <ModerationWorkspace queue={queue} />
    </div>
  );
}
