import Link from 'next/link';
import type { CustomerProfileDto } from '@echo-grid-feedback/shared-types';
import { ProfileAvatar } from './profile-avatar';
import { identityName } from '@/lib/profile-identity';

/**
 * "Signed in as ..." for the customer shell: avatar, name and masked sign-in handle, linking to the profile. Shows only a plain
 * label when the profile could not be read, so the header never breaks.
 */
export function SignedInAs({
  profile,
  labels,
}: {
  profile: CustomerProfileDto | null;
  labels: { fallback: string; signedInAs: string; profile: string };
}) {
  const name = identityName(profile);
  if (!profile || !name) {
    return <p className="text-sm font-semibold">{labels.fallback}</p>;
  }
  return (
    <Link
      href="/loyalty/dashboard/profile"
      aria-label={`${labels.signedInAs} ${name}. ${labels.profile}`}
      className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      <ProfileAvatar avatarKey={profile.avatarKey} name={name} size={32} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-semibold">{name}</span>
        <span className="truncate text-xs text-neutral-600">
          {labels.signedInAs}
          {profile.maskedLogin ? ` · ${profile.maskedLogin}` : ''}
        </span>
      </span>
    </Link>
  );
}
