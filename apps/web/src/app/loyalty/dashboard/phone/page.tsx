import { PhoneVerifyForm } from './phone-verify-form';
import { getPhoneStatus } from '@/lib/customer-phone-status';
import { safeInternalPath } from '@/lib/safe-redirect';

export const dynamic = 'force-dynamic';

/** Inside the customer dashboard layout, which already requires a signed-in customer. */
export default async function CustomerPhonePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const status = await getPhoneStatus();
  return (
    <section className="flex justify-center">
      <PhoneVerifyForm status={status} next={safeInternalPath(next, '/loyalty/dashboard')} />
    </section>
  );
}
