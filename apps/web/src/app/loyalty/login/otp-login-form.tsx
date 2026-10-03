'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import {
  requestOtpAction,
  type OtpRequestState,
} from '@/lib/actions/customer-auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { Logo } from '@/components/brand';

const requestInitial: OtpRequestState = {};

interface OtpLoginFormProps {
  next: string;
  initialPhone?: string | undefined;
  verifyError?: string | undefined;
}

/**
 * Two-step SMS OTP sign-in. The request step is a Server Action. The verify
 * step is a native document POST: the route sets the httpOnly customer cookie
 * and redirects to the QR loyalty page in one response, so Cloudflare and the
 * browser cannot race a separate client navigation against cookie storage.
 */
export function OtpLoginForm({ next, initialPhone, verifyError }: OtpLoginFormProps) {
  const [requestState, requestFormAction, requestPending] = useActionState(
    requestOtpAction,
    requestInitial,
  );
  const t = useTranslations('loyalty.customer.login');
  const verificationPhone = requestState.sent ? requestState.phone : initialPhone;
  const codeSent = Boolean(verificationPhone);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-8">
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {codeSent
              ? t('codeSentDescription', { phone: verificationPhone ?? '' })
              : t('phoneDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!codeSent ? (
            <form action={requestFormAction} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="phone">{t('phoneLabel')}</Label>
                <Input
                  id="phone"
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+15551234567"
                  required
                />
                <p className="text-xs text-neutral-500">{t('phoneHint')}</p>
              </div>
              {requestState.error && (
                <p role="alert" className="text-sm text-danger">
                  {requestState.error}
                </p>
              )}
              <Button type="submit" disabled={requestPending} className="w-full">
                {requestPending ? t('sending') : t('sendCode')}
              </Button>
            </form>
          ) : (
            <form action="/api/customer-auth/otp/verify" method="post" className="flex flex-col gap-4">
              <input type="hidden" name="phone" value={verificationPhone} />
              <input type="hidden" name="next" value={next} />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="code">{t('codeLabel')}</Label>
                <Input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                />
              </div>
              {verifyError && (
                <p role="alert" className="text-sm text-danger">
                  {verifyError}
                </p>
              )}
              <Button type="submit" className="w-full">
                {t('verify')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
