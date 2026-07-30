'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { loginAction, type AuthActionState } from '@/lib/actions/auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { Logo } from '@/components/brand';

const initialState: AuthActionState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  // i18n & Multi-Currency Block 4. state.error itself stays untranslated --
  // it's the API's raw error message, not a UI string this component owns;
  // see docs note in i18n & Multi-Currency's Block 4 completion summary.
  const t = useTranslations('auth.login');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-8">
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-4">
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
                autoComplete="current-password"
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
          <p className="mt-4 text-center text-sm text-neutral-500">
            {t('noAccount')}{' '}
            <Link href="/signup" className="font-medium text-brand-700 hover:underline">
              {t('signupLink')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
