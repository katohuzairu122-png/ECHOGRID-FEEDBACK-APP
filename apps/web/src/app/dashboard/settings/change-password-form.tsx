'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import {
  changePasswordAction,
  type ChangePasswordActionState,
} from '@/lib/actions/auth';
import { Button, Input, Label } from '@/components/ui';

const initialState: ChangePasswordActionState = {};

/**
 * Authenticated password-change form.
 *
 * The API requires the user's current password before accepting a new one.
 * A successful change revokes every refresh session, including the current
 * browser session, so changePasswordAction clears the local cookies and
 * redirects the user to /login.
 *
 * API failures leave the existing session intact so an incorrect current
 * password or another validation failure does not unexpectedly sign the
 * user out.
 */
export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(
    changePasswordAction,
    initialState,
  );

  const t = useTranslations('dashboard.settings');

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="currentPassword">
          {t('currentPasswordLabel')}
        </Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="newPassword">
          {t('newPasswordLabel')}
        </Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
        <p className="text-xs text-neutral-500">
          {t('passwordHint')}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirmPassword">
          {t('confirmPasswordLabel')}
        </Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? t('changePasswordPending') : t('changePasswordSubmit')}
      </Button>
    </form>
  );
}
