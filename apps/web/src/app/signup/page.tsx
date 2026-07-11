'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { signupAction, type AuthActionState } from '@/lib/actions/auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';

const initialState: AuthActionState = {};

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signupAction, initialState);
  // i18n & Multi-Currency Block 4 -- see login/page.tsx's identical note on
  // state.error staying untranslated.
  const t = useTranslations('auth.signup');

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fullName">{t('fullNameLabel')}</Label>
              <Input id="fullName" name="fullName" autoComplete="name" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">{t('emailLabel')}</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">{t('passwordLabel')}</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
              <p className="text-xs text-neutral-500">{t('passwordHint')}</p>
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
          <p className="mt-4 text-center text-sm text-neutral-500">
            {t('hasAccount')}{' '}
            <Link href="/login" className="font-medium text-brand-600 hover:underline">
              {t('loginLink')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
