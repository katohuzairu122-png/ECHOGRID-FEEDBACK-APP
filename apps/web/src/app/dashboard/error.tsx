'use client';

import { ErrorState } from '@/components/error-state';

/**
 * Staff dashboard boundary. Exists separately from app/error.tsx so a failed
 * page renders INSIDE dashboard/layout.tsx -- the nav stays on screen and the
 * user can move to another section instead of being stranded on a bare page
 * with only a retry button.
 *
 * That is the whole reason this file is not redundant: a boundary's position
 * in the tree decides how much chrome survives the error.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} />;
}
