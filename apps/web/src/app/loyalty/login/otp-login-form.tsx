'use client';

import { useActionState, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  requestOtpAction,
  type OtpRequestState,
} from '@/lib/actions/customer-auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { Logo } from '@/components/brand';
import { navigateWithCommittedCookies } from '@/lib/browser-navigation';

const requestInitial: OtpRequestState = {};

interface OtpLoginFormProps {
  next: string;
}

interface VerifyResponse {
  error?: string;
}

/**
 * Two-step SMS OTP sign-in. The request step is a Server Action; verification
 * uses a same-origin route handler so its Set-Cookie header is written directly
 * to the browser response before navigation. This avoids Cloudflare dropping
 * cookie mutations attached to a Server Action response.
 */
export function OtpLoginForm({ next }: OtpLoginFormProps) {
  const [requestState, requestFormAction, requestPending] = useActionState(
    requestOtpAction,
    requestInitial,
  );
  const [verifyPending, setVerifyPending] = useState(false);
  const [verifyError, setVerifyError] = useState<string>();
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.customer.login');

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setVerifyError(undefined);
    setVerifyPending(true);

    const formData = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/customer-auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: String(formData.get('phone') ?? ''),
          code: String(formData.get('code') ?? ''),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as VerifyResponse;
      if (!response.ok) {
        setVerifyError(result.error ?? t('genericError'));
        return;
      }

      // fetch has fully processed the Set-Cookie response at this point. A
      // document navigation now carries the new customer session.
      navigateWithCommittedCookies(next);
    } catch {
      setVerifyError(t('genericError'));
    } finally {
      setVerifyPending(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-8">
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {requestState.sent
              ? t('codeSentDescription', { phone: requestState.phone ?? '' })
              : t('phoneDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!requestState.sent ? (
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
            <form onSubmit={handleVerify} className="flex flex-col gap-4">
              <input type="hidden" name="phone" value={requestState.phone} />
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
              <Button type="submit" disabled={verifyPending} className="w-full">
                {verifyPending ? t('verifying') : t('verify')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
