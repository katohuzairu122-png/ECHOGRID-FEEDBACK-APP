'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { requestEmailRegistrationAction, type EmailAuthState } from '@/lib/actions/customer-email-auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { Logo } from '@/components/brand';
import { LanguageSelector } from '@/components/language-selector';

const initial: EmailAuthState = {};

/** Step 1 of sign-up. The answer is always "check your email" for a well-formed address, so it never reveals who is registered. */
export function SignupRequestForm({ next, minLength }: { next: string; minLength?: number | undefined }) {
  const [state, formAction, pending] = useActionState(requestEmailRegistrationAction, initial);
  const [fields, setFields] = useState({ name: '', email: '', password: '', passwordConfirmation: '' });
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
            <Link href={`/loyalty/login?next=${encodeURIComponent(next)}`} className="text-sm font-medium text-brand-700 hover:underline">
              {t('haveAccountLink')}
            </Link>
          ) : (
            <form action={formAction} className="flex flex-col gap-4">
              <input type="hidden" name="next" value={next} />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">{t('nameLabel')}</Label>
                <Input id="name" name="name" type="text" autoComplete="name" maxLength={120} required value={fields.name} onChange={(e) => setFields((current) => ({ ...current, name: e.target.value }))} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">{t('emailLabel')}</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required value={fields.email} onChange={(e) => setFields((current) => ({ ...current, email: e.target.value }))} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">{t('createPasswordLabel')}</Label>
                <Input id="password" name="password" type="password" autoComplete="new-password" required value={fields.password} onChange={(e) => setFields((current) => ({ ...current, password: e.target.value }))} {...(minLength ? { minLength } : {})} />
                {minLength ? <p className="text-xs text-neutral-500">{t('passwordHint', { min: minLength })}</p> : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="passwordConfirmation">{t('confirmPasswordLabel')}</Label>
                <Input id="passwordConfirmation" name="passwordConfirmation" type="password" autoComplete="new-password" required value={fields.passwordConfirmation} onChange={(e) => setFields((current) => ({ ...current, passwordConfirmation: e.target.value }))} {...(minLength ? { minLength } : {})} />
              </div>
              {state.error && (
                <p role="alert" className="text-sm text-danger">
                  {t(`errors.${state.error}`)}
                </p>
              )}
              <Button type="submit" disabled={pending} className="w-full">
                {pending ? t('sending') : t('sendLink')}
              </Button>
              <Link href={`/loyalty/login?next=${encodeURIComponent(next)}`} className="text-center text-sm font-medium text-brand-700 hover:underline">
                {t('haveAccountLink')}
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
