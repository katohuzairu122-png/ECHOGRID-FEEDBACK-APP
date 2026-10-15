import Link from 'next/link';
import { resolveOptionalQrActions } from '@/lib/optional-qr-actions';

export async function SettlementQrEntry({ token }: { token: string }) {
  const result = await resolveOptionalQrActions(token);
  if (!result) return null;
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
