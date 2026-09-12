'use client';

import { ErrorState } from '@/components/error-state';

/**
 * Customer loyalty-dashboard boundary.
 *
 * The 401 case that used to land here is now handled before it throws --
 * customerApiFetch redirects to /loyalty/login instead (audit P1-2). This
 * boundary covers everything else: a 500 from the API, a network failure, a
 * malformed response. Worth having for the same reason as the others, and
 * more so here, because the person hitting it is a customer of the business
 * rather than staff and has no reason to extend the platform any patience.
 */
export default function LoyaltyDashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} />;
}
