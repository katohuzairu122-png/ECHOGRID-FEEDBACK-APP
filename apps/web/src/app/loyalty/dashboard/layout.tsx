import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { hasCustomerSession } from '@/lib/customer-session';
import { customerLogoutAction } from '@/lib/actions/customer-auth';
import { Button } from '@/components/ui';

/** Customer counterpart to app/dashboard/layout.tsx -- same defense-in-depth
 * shape (middleware already scopes /loyalty as public, so this layout is
 * the actual gate for the customer-authenticated subtree), separate cookie
 * check (hasCustomerSession, not hasSession). Async in part for
 * getTranslations() (i18n & Multi-Currency Block 6). */
export default async function LoyaltyDashboardLayout({ children }: { children: React.ReactNode }) {
  if (!(await hasCustomerSession())) {
    redirect('/loyalty/login');
  }

  const t = await getTranslations('loyalty.customer.shell');

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/loyalty/dashboard" className="text-lg font-semibold text-neutral-900">
            {t('brand')}
          </Link>
          <form action={customerLogoutAction}>
            <Button type="submit" variant="ghost" size="sm">
              {t('logout')}
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>
    </div>
  );
}
