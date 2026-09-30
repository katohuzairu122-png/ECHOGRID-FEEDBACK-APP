import { redirect } from 'next/navigation';
import type { CurrentUserDto } from '@echo-grid-feedback/shared-types';
import { getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { SettingsForm } from './settings-form';
import { ChangePasswordForm } from './change-password-form';
import { ProfileForm } from './profile-form';

/**
 * Business settings -- name and locale/currency/timezone defaults (i18n &
 * Multi-Currency Block 3, translated in Block 4 as part of the same pass
 * that translated this page's own nav entry). Top-level nav entry, not
 * nested under any existing module: these fields are business-wide, not
 * owned by Branches/Loyalty/Analytics. See lib/actions/business.ts's
 * updateBusinessSettingsAction for the write path and its permission note.
 */
export default async function BusinessSettingsPage() {
  const [business, user] = await Promise.all([
    getActiveBusiness(),
    apiFetch<CurrentUserDto>('/auth/me'),
  ]);
  if (!business) redirect('/dashboard');

  const t = await getTranslations('dashboard.settings');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{business.name}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('profileTitle')}</CardTitle>
          <CardDescription>{t('profileDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm user={user} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('generalTitle')}</CardTitle>
          <CardDescription>{t('generalDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm business={business} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('securityTitle')}</CardTitle>
          <CardDescription>{t('securityDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
