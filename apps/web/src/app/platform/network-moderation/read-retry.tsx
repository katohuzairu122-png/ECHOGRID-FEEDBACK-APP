'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

/** Refresh only the current server read, preserving its cursor and selection. */
export function ModerationReadRetry() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="secondary"
      className="ms-2"
      disabled={pending}
      aria-busy={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? 'Retrying…' : 'Retry loading'}
    </Button>
  );
}
