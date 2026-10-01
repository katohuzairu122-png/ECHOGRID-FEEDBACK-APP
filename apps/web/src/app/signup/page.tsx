'use client';

import { useActionState, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { signupAction, type AuthActionState } from '@/lib/actions/auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { Logo } from '@/components/brand';

const initialState: AuthActionState = {};

export default function SignupPage() {
  const [next, setNext] = useState('/dashboard');
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('next');
    if (requested?.startsWith('/') && !requested.startsWith('//')) setNext(requested);
  }, []);
  const [state, formAction, pending] = useActionState(signupAction, initialState);
  // i18n & Multi-Currency Block 4 -- see login/page.tsx's identical note on
  // state.error staying untranslated.
  const t = useTranslations('auth.signup');

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
            <input type="hidden" name="next" value={next} />
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
            <div className="flex items-start gap-2">
              <input
                id="acceptTerms"
                name="acceptTerms"
                type="checkbox"
                required
                className="mt-1 h-4 w-4 rounded border-neutral-300 text-brand-700"
              />
              <Label htmlFor="acceptTerms" className="text-sm font-normal leading-5 text-neutral-600">
                {t('acceptTermsPrefix')}{' '}
                <Link href="/terms" target="_blank" className="font-medium text-brand-700 hover:underline">
                  {t('termsLink')}
                </Link>{' '}
                {t('and')}{' '}
                <Link href="/privacy" target="_blank" className="font-medium text-brand-700 hover:underline">
                  {t('privacyLink')}
                </Link>
                .
              </Label>
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
            <Link href={`/login?next=${encodeURIComponent(next)}`} className="font-medium text-brand-700 hover:underline">
              {t('loginLink')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
