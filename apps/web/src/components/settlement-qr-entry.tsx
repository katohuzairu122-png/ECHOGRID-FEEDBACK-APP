import Link from 'next/link';
import type { ResolveBusinessQrActionsResultDto } from '@echo-grid-feedback/shared-types';
import { hasCustomerSession } from '@/lib/customer-session';
import { customerApiFetch } from '@/lib/customer-api-client';

export async function SettlementQrEntry({ token }: { token: string }) {
  if (!(await hasCustomerSession())) return null;
  const result = await customerApiFetch<ResolveBusinessQrActionsResultDto>(
    '/loyalty/me/actions/resolve-business',
    {
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify({ businessQrToken: token }),
    },
    `/feedback/${encodeURIComponent(token)}`,
  );
  if (!result.actions.includes('SETTLE_ORPHAN_REWARD')) return null;
  return (
    <Link
      href={`/loyalty/dashboard/settlements?businessQrToken=${encodeURIComponent(token)}`}
      className="mt-4 inline-block rounded-lg border px-5 py-3"
    >
      Request consented orphan reward settlement
    </Link>
  );
}
