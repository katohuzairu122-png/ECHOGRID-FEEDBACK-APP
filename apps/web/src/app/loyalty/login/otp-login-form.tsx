'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import {
  requestOtpAction,
  verifyOtpAction,
  type OtpRequestState,
  type OtpVerifyState,
} from '@/lib/actions/customer-auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { Logo } from '@/components/brand';

const requestInitial: OtpRequestState = {};
const verifyInitial: OtpVerifyState = {};

interface OtpLoginFormProps {
  next: string;
}

/**
 * Two-step SMS OTP sign-in, the customer counterpart to app/login/page.tsx.
 * Both steps are separate useActionState-bound forms rather than one form
 * with conditional fields -- requestState.sent gates which one renders, so
 * the phone number (needed by BOTH steps) is carried forward as a hidden
 * field in the verify form rather than re-typed.
 */
export function OtpLoginForm({ next }: OtpLoginFormProps) {
  const [requestState, requestFormAction, requestPending] = useActionState(
    requestOtpAction,
    requestInitial,
  );
  const [verifyState, verifyFormAction, verifyPending] = useActionState(
    verifyOtpAction,
    verifyInitial,
  );
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.customer.login');

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
            <form action={verifyFormAction} className="flex flex-col gap-4">
              <input type="hidden" name="phone" value={requestState.phone} />
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
              {verifyState.error && (
                <p role="alert" className="text-sm text-danger">
                  {verifyState.error}
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
