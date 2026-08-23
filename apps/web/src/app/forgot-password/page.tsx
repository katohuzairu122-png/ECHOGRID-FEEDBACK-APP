'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  requestPasswordResetAction,
  type PasswordResetActionState,
} from '@/lib/actions/auth';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui';
import { Logo } from '@/components/brand';

const initialState: PasswordResetActionState = {};

/**
 * Step 1 of account recovery. Same shell as login/signup (centred Card under
 * the wordmark) so the recovery path never feels like a different product.
 *
 * The confirmation shown after submitting is deliberately worded to promise
 * nothing about whether an account exists -- "if an account exists for that
 * address" rather than "check your inbox". The API answers 202 for unknown
 * addresses specifically to avoid handing out an account-enumeration oracle
 * (see POST /auth/password-reset/request); a UI that said "sent!" for real
 * addresses and something else for unknown ones would give that away
 * regardless of what the API withheld.
 */
export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordResetAction, initialState);
  // state.error stays untranslated -- it's the API's raw message, not a UI
  // string this component owns. Same note as login/page.tsx.
  const t = useTranslations('auth.forgotPassword');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-8">
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {state.submitted ? t('submittedDescription') : t('description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.submitted ? (
            // role="status", not role="alert": this is a non-urgent
            // confirmation, and alert interrupts a screen reader mid-sentence.
            <p role="status" className="text-sm text-neutral-600">
              {t('submittedBody')}
            </p>
          ) : (
            <form action={formAction} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">{t('emailLabel')}</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
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
          )}
          <p className="mt-4 text-center text-sm text-neutral-500">
            <Link href="/login" className="font-medium text-brand-700 hover:underline">
              {t('backToLogin')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
