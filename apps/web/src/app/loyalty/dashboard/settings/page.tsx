import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { customerApiFetch } from '@/lib/customer-api-client';
import type { CustomerProfileDto } from '@/lib/customer-profile';
import { CustomerProfileForm } from './profile-form';
import {
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { getCompatibleCustomerCredentials } from '@/lib/customer-session';
import { CustomerSecurityForm } from './security-form';
import { CustomerEmailUpgradeForm } from './email-upgrade-form';
import {
  isCustomerEmailAuthWebEnabled,
  isCustomerRecoveryWebEnabled,
} from '@/lib/customer-email-auth-client';
import { CustomerRecoveryCodesForm } from './recovery-codes-form';
import { CustomerDeletionRequestForm } from './deletion-request-form';
import { isCustomerDeletionWebEnabled } from '@/lib/actions/customer-deletion';

export const dynamic = 'force-dynamic';

export default async function CustomerSettingsPage() {
  const [profile, t, recoveryT, credentials] = await Promise.all([
    customerApiFetch<CustomerProfileDto>('/loyalty/me/profile'),
    getTranslations('loyalty.customer.settings'),
    getTranslations('loyalty.customer.accountRecovery'),
    getCompatibleCustomerCredentials(),
  ]);
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="mt-1 text-sm text-neutral-600">{t('description')}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('profileTitle')}</CardTitle>
          <CardDescription>{t('profileDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <CustomerProfileForm name={profile.name ?? ''} />
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-neutral-700">{t('emailLabel')}</dt>
              <dd className="text-neutral-900">{profile.email ?? t('notSet')}</dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-700">{t('emailStatusLabel')}</dt>
              <dd className="text-neutral-900">
                {profile.emailVerified ? t('verified') : t('unverified')}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-700">{t('phoneLabel')}</dt>
              <dd className="text-neutral-900">{profile.phoneMasked ?? t('notSet')}</dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-700">{t('phoneStatusLabel')}</dt>
              <dd className="text-neutral-900">
                {profile.phoneVerified ? t('verified') : t('unverified')}
              </dd>
            </div>
          </dl>
          <div>
            <Link
              href="/loyalty/dashboard/phone"
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              {t('phoneAction')}
            </Link>
            <p className="mt-2 text-xs text-neutral-600">{t('phoneChangeNote')}</p>
          </div>
        </CardContent>
      </Card>
      {profile.emailVerified &&
        credentials.kind === 'rotating' &&
        isCustomerRecoveryWebEnabled() && (
          <Card>
            <CardHeader>
              <CardTitle>{recoveryT('recoveryCodesTitle')}</CardTitle>
              <CardDescription>{recoveryT('recoveryCodesDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <CustomerRecoveryCodesForm />
            </CardContent>
          </Card>
        )}
      <Card>
        <CardHeader>
          <CardTitle>{t('securityTitle')}</CardTitle>
          <CardDescription>{t('securityDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {profile.emailVerified ? (
            <CustomerSecurityForm canManageSessions={credentials.kind === 'rotating'} />
          ) : isCustomerEmailAuthWebEnabled() &&
            process.env.CUSTOMER_LEGACY_UPGRADE_ENABLED === 'true' ? (
            <CustomerEmailUpgradeForm canUpgrade={credentials.kind === 'rotating'} />
          ) : (
            <p className="text-sm text-neutral-600">{t('passwordNotAvailable')}</p>
          )}
        </CardContent>
      </Card>
      {isCustomerDeletionWebEnabled() && profile.emailVerified && credentials.kind === 'rotating' && (
        <Card>
          <CardHeader>
            <CardTitle>{(await getTranslations('loyalty.customer.accountDeletion'))('title')}</CardTitle>
          </CardHeader>
          <CardContent><CustomerDeletionRequestForm /></CardContent>
        </Card>
      )}
    </section>
  );
}
