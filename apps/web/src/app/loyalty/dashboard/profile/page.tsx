import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { loadGlobalProfile } from '@/lib/global-profile-server';
import { identityName } from '@/lib/profile-identity';
import { ProfileAvatar } from '@/components/profile/profile-avatar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { GlobalProfileForm } from './profile-form';

export const dynamic = 'force-dynamic';

/**
 * PROF-02: "My profile": how the customer appears on the platform (display name, short bio, avatar). The profile is private to
 * the customer; a business sees only the display name and avatar of its own members. Account details and security stay
 * under Settings. When the profile service is not available the page says so instead of showing an empty form.
 */
export default async function CustomerProfilePage() {
  const [t, profile] = await Promise.all([getTranslations('loyalty.customer.profile'), loadGlobalProfile()]);
  const name = identityName(profile);
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="mt-1 text-sm text-neutral-600">{t('description')}</p>
      </div>
      {profile === null ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('unavailableTitle')}</CardTitle>
            <CardDescription>{t('unavailableBody')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="flex items-center gap-4 pt-6">
              <ProfileAvatar avatarKey={profile.avatarKey} name={name} size={64} />
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold text-neutral-900">{name ?? t('noName')}</p>
                {profile.maskedLogin ? <p className="truncate text-sm text-neutral-600">{t('signedInWith', { login: profile.maskedLogin })}</p> : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('editTitle')}</CardTitle>
              <CardDescription>{t('privacy')}</CardDescription>
            </CardHeader>
            <CardContent>
              <GlobalProfileForm
                displayName={profile.displayName}
                bio={profile.bio}
                avatarKey={profile.avatarKey}
                fallbackName={profile.fullName}
              />
            </CardContent>
          </Card>
          <p className="text-sm text-neutral-600">
            <Link href="/loyalty/dashboard/settings" className="text-brand-700 underline">{t('settingsLink')}</Link>
          </p>
        </>
      )}
    </section>
  );
}
