'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { requestEmailRegistrationAction, type EmailAuthState } from '@/lib/actions/customer-email-auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { Logo } from '@/components/brand';
import { LanguageSelector } from '@/components/language-selector';

const initial: EmailAuthState = {};

/** Step 1 of sign-up. The answer is always "check your email" for a well-formed address, so it never reveals who is registered. */
export function SignupRequestForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(requestEmailRegistrationAction, initial);
  const t = useTranslations('loyalty.customer.emailAuth');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-8">
      <LanguageSelector className="w-40 self-end" />
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{state.sent ? t('sentTitle') : t('signUpTitle')}</CardTitle>
          <CardDescription>{state.sent ? t('sentDescription') : t('signUpDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {state.sent ? (
            <Link href={`/loyalty/login/email?next=${encodeURIComponent(next)}`} className="text-sm font-medium text-brand-700 hover:underline">
              {t('haveAccountLink')}
            </Link>
          ) : (
            <form action={formAction} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">{t('emailLabel')}</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </div>
              {state.error && (
                <p role="alert" className="text-sm text-danger">
                  {t(`errors.${state.error}`)}
                </p>
              )}
              <Button type="submit" disabled={pending} className="w-full">
                {pending ? t('sending') : t('sendLink')}
              </Button>
              <Link href={`/loyalty/login/email?next=${encodeURIComponent(next)}`} className="text-center text-sm font-medium text-brand-700 hover:underline">
                {t('haveAccountLink')}
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
