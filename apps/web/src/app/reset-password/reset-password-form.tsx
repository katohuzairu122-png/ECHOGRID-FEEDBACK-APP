'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { resetPasswordAction, type PasswordResetActionState } from '@/lib/actions/auth';
import { Button, buttonVariants, Input, Label } from '@/components/ui';
import { cn } from '@/lib/utils';

const initialState: PasswordResetActionState = {};

interface ResetPasswordFormProps {
  token: string;
}

/**
 * The interactive half of /reset-password, split out so the page itself can
 * stay a Server Component and read `searchParams` directly (see page.tsx).
 *
 * On success this renders a confirmation with a link to log in, rather than
 * redirecting. The reset revokes every session, so the user is logged out
 * either way -- but an unexplained bounce to a login form reads as a
 * failure, and the one thing account recovery must never be is ambiguous.
 */
export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, initialState);
  // state.error stays untranslated -- API-owned message. Same note as
  // login/page.tsx. The one exception is the passwords-do-not-match case,
  // which the Server Action produces itself; translating it would mean
  // teaching the action about locales, so it stays English alongside the
  // API's own messages rather than being half-translated.
  const t = useTranslations('auth.resetPassword');

  if (state.success) {
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="text-sm text-neutral-600">
          {t('successBody')}
        </p>
        {/* buttonVariants() on the Link itself, never <Button><Link/></Button>
            -- nesting interactive elements breaks accessible-name
            computation and click semantics. This is button.tsx's own
            documented pattern for exactly this case. */}
        <Link href="/login" className={cn(buttonVariants(), 'w-full')}>
          {t('successLoginLink')}
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {/* The token travels in a hidden field rather than being re-read from
          the URL inside the action: a Server Action receives only what the
          form sends it, and it has no access to the page's query string. */}
      <input type="hidden" name="token" value={token} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="newPassword">{t('newPasswordLabel')}</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
        <p className="text-xs text-neutral-500">{t('passwordHint')}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirmPassword">{t('confirmPasswordLabel')}</Label>
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
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? t('submitPending') : t('submit')}
      </Button>
    </form>
  );
}
