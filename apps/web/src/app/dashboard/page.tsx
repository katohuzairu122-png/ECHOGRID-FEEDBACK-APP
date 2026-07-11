import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { getCurrentUser } from '@/lib/platform';
import { CreateBusinessForm } from './create-business-form';
import { buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

export default async function DashboardPage() {
  const business = await getActiveBusiness();

  if (!business) {
    return <CreateBusinessForm />;
  }

  // i18n & Multi-Currency Block 4.
  const t = await getTranslations('dashboard.home');
  // Platform Admin Console Block 5 -- the console's one discoverable entry
  // point from the business dashboard. Deliberately placed here (dashboard
  // home, visited once per session in the common case) rather than in the
  // shared nav (every page navigation) -- see dashboard-nav.tsx's comment
  // for the reasoning. Costs one extra /auth/me call, only on this page.
  const user = await getCurrentUser();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{business.name}</h1>
        <p className="text-sm text-neutral-500">/{business.slug}</p>
      </div>
      {user?.platformRole && (
        <Card>
          <CardHeader>
            <CardTitle>{t('platformAdminTitle')}</CardTitle>
            <CardDescription>{t('platformAdminDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/platform" className={buttonVariants({ variant: 'outline' })}>
              {t('viewPlatformAdmin')}
            </Link>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('branchesTitle')}</CardTitle>
          <CardDescription>{t('branchesDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Styled as a button via buttonVariants rather than wrapping a
              <Button> in this <Link> -- nesting a real <button> inside an
              <a> is invalid HTML and breaks accessible-name computation. */}
          <Link href="/dashboard/branches" className={buttonVariants({ variant: 'outline' })}>
            {t('viewBranches')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
