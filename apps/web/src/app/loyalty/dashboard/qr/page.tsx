import { customerApiFetch } from '@/lib/customer-api-client';
import { CustomerQrDisplay } from './customer-qr-display';
export const dynamic = 'force-dynamic';
export default async function CustomerQrPage() {
  const qr = await customerApiFetch<{ token: string; expiresAt: string }>(
    '/loyalty/me/customer-qr',
    { cache: 'no-store' },
  );
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">My customer QR</h1>
      <p>
        Show this short-lived identity to authorized staff. It contains no balances, permissions or
        business relationships. Purchase validation and reward handoff require separate staff
        actions.
      </p>
      <CustomerQrDisplay {...qr} />
    </section>
  );
}
