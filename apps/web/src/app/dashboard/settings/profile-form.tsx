'use client';

import { useActionState } from 'react';
import type { CurrentUserDto } from '@echo-grid-feedback/shared-types';
import { useTranslations } from 'next-intl';
import { updateProfileAction, type ProfileActionState } from '@/lib/actions/auth';
import { Button, Input, Label } from '@/components/ui';

const initialState: ProfileActionState = {};

export function ProfileForm({ user }: { user: CurrentUserDto }) {
  const [state, formAction, pending] = useActionState(updateProfileAction, initialState);
  const t = useTranslations('dashboard.settings');

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profileFullName">{t('profileNameLabel')}</Label>
        <Input id="profileFullName" name="fullName" defaultValue={user.fullName} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profileEmail">{t('profileEmailLabel')}</Label>
        <Input id="profileEmail" value={user.email} disabled />
        <p className="text-xs text-neutral-500">{t('profileEmailHint')}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profilePhone">{t('profilePhoneLabel')}</Label>
        <Input id="profilePhone" name="phone" type="tel" defaultValue={user.phone ?? ''} />
      </div>
      {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      {state.success && <p className="text-sm text-success">{t('profileSuccess')}</p>}
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? t('profileSubmitPending') : t('profileSubmit')}
      </Button>
    </form>
  );
}
