import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { BranchDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { BranchFormDialog } from './branch-form-dialog';
import { DeleteBranchButton } from './delete-branch-button';
import { QrCodeDialog } from './qr-code-dialog';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

export default async function BranchesPage() {
  const business = await getActiveBusiness();
  // Onboarding (dashboard/page.tsx) is the only place that creates a
  // business -- reaching this route without one means it was navigated to
  // directly before that step, so send back rather than fetching branches
  // for a business that doesn't exist.
  if (!business) redirect('/dashboard');

  // i18n & Multi-Currency Block 5.
  const t = await getTranslations('branches');

  const branches = await apiFetch<BranchDto[]>('/branches', { businessId: business.id });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
          <p className="text-sm text-neutral-500">{business.name}</p>
        </div>
        <BranchFormDialog trigger={<Button type="button">{t('newButton')}</Button>} />
      </div>

      {branches.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyTitle')}</CardTitle>
            <CardDescription>{t('emptyDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {branches.map((branch) => (
            <Card key={branch.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div>
                  <p className="font-medium text-neutral-900">{branch.name}</p>
                  <p className="text-sm text-neutral-500">
                    /{branch.slug}
                    {branch.city ? ` · ${branch.city}` : ''}
                    {branch.countryCode ? `, ${branch.countryCode}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <QrCodeDialog
                    branchId={branch.id}
                    branchName={branch.name}
                    trigger={
                      <Button type="button" variant="outline" size="sm">
                        {t('qrButton')}
                      </Button>
                    }
                  />
                  <BranchFormDialog
                    branch={branch}
                    trigger={
                      <Button type="button" variant="outline" size="sm">
                        {t('editButton')}
                      </Button>
                    }
                  />
                  <DeleteBranchButton branchId={branch.id} branchName={branch.name} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
