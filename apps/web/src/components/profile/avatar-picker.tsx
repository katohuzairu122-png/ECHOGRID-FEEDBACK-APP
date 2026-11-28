'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { CustomerAvatarKey } from '@echo-grid-feedback/shared-types';
import { ProfileAvatar } from './profile-avatar';
import { AVATAR_KEYS } from './avatar-catalogue';

/** Choose a built-in avatar, or none (initials are shown instead). Submits as the form field `avatarKey` ('' = none). */
export function AvatarPicker({ initial, name }: { initial: CustomerAvatarKey | null; name: string | null }) {
  const t = useTranslations('loyalty.customer.profile');
  const [value, setValue] = useState<CustomerAvatarKey | ''>(initial ?? '');
  const option = (key: CustomerAvatarKey | '', label: string) => (
    <label key={key || 'none'} className="cursor-pointer">
      <input
        type="radio"
        name="avatarKey"
        value={key}
        checked={value === key}
        onChange={() => setValue(key)}
        className="peer sr-only"
      />
      <span
        title={label}
        className="flex flex-col items-center gap-1 rounded-lg border border-transparent p-1.5 text-xs text-neutral-700 peer-checked:border-brand-600 peer-checked:bg-brand-50 peer-focus-visible:outline-2 peer-focus-visible:outline-brand-600"
      >
        <ProfileAvatar avatarKey={key || null} name={name} size={44} />
        <span className="max-w-16 truncate">{label}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-neutral-900">{t('avatarLabel')}</legend>
      <p className="text-xs text-neutral-600">{t('avatarHint')}</p>
      <div className="flex flex-wrap gap-1.5">
        {option('', t('avatarNone'))}
        {AVATAR_KEYS.map((key) => option(key, t(`avatars.${key}`)))}
      </div>
    </fieldset>
  );
}
