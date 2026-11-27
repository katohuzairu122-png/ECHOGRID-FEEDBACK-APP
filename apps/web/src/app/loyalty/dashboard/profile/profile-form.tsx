'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { CustomerAvatarKey } from '@echo-grid-feedback/shared-types';
import { BIO_MAX, DISPLAY_NAME_MAX } from '@echo-grid-feedback/shared-types';
import { updateGlobalProfileAction, type GlobalProfileFormState } from '@/lib/actions/global-profile';
import { AvatarPicker } from '@/components/profile/avatar-picker';
import { Button, Input, Label, Textarea } from '@/components/ui';

const initial: GlobalProfileFormState = {};

export function GlobalProfileForm({
  displayName,
  bio,
  avatarKey,
  fallbackName,
}: {
  displayName: string | null;
  bio: string | null;
  avatarKey: CustomerAvatarKey | null;
  fallbackName: string | null;
}) {
  const [state, action, pending] = useActionState(updateGlobalProfileAction, initial);
  const t = useTranslations('loyalty.customer.profile');
  return (
    <form action={action} className="flex flex-col gap-5">
      <AvatarPicker initial={avatarKey} name={displayName ?? fallbackName} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-display-name">{t('displayNameLabel')}</Label>
        <Input id="profile-display-name" name="displayName" defaultValue={displayName ?? ''} maxLength={DISPLAY_NAME_MAX} autoComplete="nickname" />
        <p className="text-xs text-neutral-600">{t('displayNameHint')}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-bio">{t('bioLabel')}</Label>
        <Textarea id="profile-bio" name="bio" defaultValue={bio ?? ''} maxLength={BIO_MAX} rows={4} />
        <p className="text-xs text-neutral-600">{t('bioHint')}</p>
      </div>
      {state.error && <p role="alert" className="text-sm text-danger">{t(`errors.${state.error}`)}</p>}
      {state.saved && <p role="status" className="text-sm text-green-700">{t('saved')}</p>}
      <Button type="submit" disabled={pending}>{pending ? t('saving') : t('save')}</Button>
    </form>
  );
}
