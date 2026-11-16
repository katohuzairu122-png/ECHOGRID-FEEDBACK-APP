'use client';

import { useActionState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { loginWithEmailAction, type EmailAuthState } from '@/lib/actions/customer-email-auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { Logo } from '@/components/brand';
import { LanguageSelector } from '@/components/language-selector';

const initial: EmailAuthState = {};

/** Email and password sign-in. The action sets the HttpOnly cookies; the client then loads `next` as a fresh document. */
export function EmailLoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(loginWithEmailAction, initial);
  const t = useTranslations('loyalty.customer.emailAuth');

  useEffect(() => {
    if (state.success && state.next) window.location.assign(state.next);
  }, [state]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-8">
      <LanguageSelector className="w-40 self-end" />
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('signInTitle')}</CardTitle>
          <CardDescription>{t('signInDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="next" value={next} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">{t('emailLabel')}</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">{t('passwordLabel')}</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            {state.error && (
              <p role="alert" className="text-sm text-danger">
                {t(`errors.${state.error}`)}
              </p>
            )}
            <Button type="submit" disabled={pending || state.success === true} className="w-full">
              {pending ? t('signingIn') : t('signInButton')}
            </Button>
            <Link href={`/loyalty/signup?next=${encodeURIComponent(next)}`} className="text-center text-sm font-medium text-brand-700 hover:underline">
              {t('createAccountLink')}
            </Link>
            <Link href={`/loyalty/login?next=${encodeURIComponent(next)}`} className="text-center text-sm font-medium text-brand-700 hover:underline">
              {t('usePhoneInstead')}
            </Link>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
