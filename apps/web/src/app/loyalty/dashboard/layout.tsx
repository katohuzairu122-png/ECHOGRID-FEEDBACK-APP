import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { hasCustomerSession } from '@/lib/customer-session';
import { customerLogoutAction } from '@/lib/actions/customer-auth';
import { Button } from '@/components/ui';
import { LanguageSelector } from '@/components/language-selector';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { WorkspaceNavigation } from '@/components/workspace/workspace-navigation';

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
  const shell = await getTranslations('common.workspace');

  return (
    <WorkspaceShell
      footer={null}
      skipLabel={shell('skip')}
      context={<p className="text-sm font-semibold">{shell('customer')}</p>}
      navigation={
        <WorkspaceNavigation
          home="/loyalty/dashboard"
          label={shell('customer')}
          menuLabel={shell('menu')}
          moreLabel={shell('more')}
          closeLabel={shell('close')}
          primaryCount={3}
          items={[
            { href: '/loyalty/dashboard', label: t('brand'), icon: 'star' },
            { href: '/loyalty/dashboard/community', label: shell('community'), icon: 'users' },
            { href: '/loyalty/dashboard/qr', label: shell('qr'), icon: 'qr' },
            { href: '/loyalty/dashboard/settlements', label: shell('settlements'), icon: 'gift' },
            { href: '/support', label: shell('support'), icon: 'chat' },
          ]}
          utilities={
            <>
              <LanguageSelector className="w-36" />
              <form action={customerLogoutAction}>
                <Button type="submit" variant="ghost">
                  {t('logout')}
                </Button>
              </form>
            </>
          }
        />
      }
    >
      {children}
    </WorkspaceShell>
  );
}
