'use client';

import { ErrorState } from '@/components/error-state';

/** Platform-admin boundary -- same nav-preserving reasoning as
 * dashboard/error.tsx, one level over. */
export default function PlatformError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} />;
}
