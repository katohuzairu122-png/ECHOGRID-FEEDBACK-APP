'use client';

import { useActionState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  requestPhoneCodeAction,
  verifyPhoneCodeAction,
  type PhoneState,
} from '@/lib/actions/customer-phone';
import type { PhoneStatusDto } from '@/lib/customer-phone-status';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';

const initial: PhoneState = {};

/**
 * Two steps: text a code to the number, then check it. The number on file is shown MASKED only; the customer types the
 * number to verify. Errors are translated codes. A wrong code keeps the code step open.
 */
export function PhoneVerifyForm({ status, next }: { status: PhoneStatusDto; next: string }) {
  const t = useTranslations('loyalty.customer.phoneVerify');
  const [requestState, requestAction, requesting] = useActionState(requestPhoneCodeAction, initial);
  const [verifyState, verifyAction, verifying] = useActionState(verifyPhoneCodeAction, initial);

  const verified = status.verified || verifyState.verified === true;
  const codeStep = !verified && (verifyState.sent === true || requestState.sent === true);
  const phone = verifyState.phone ?? requestState.phone ?? '';
  const error = verifyState.error ?? requestState.error;

  useEffect(() => {
    if (verifyState.verified && verifyState.next) window.location.assign(verifyState.next);
  }, [verifyState]);

  if (verified) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('verifiedTitle')}</CardTitle>
          <CardDescription>{t('verifiedDescription', { phone: status.phoneMasked ?? phone })}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={next} className="text-sm font-medium text-brand-700 hover:underline">
            {t('continue')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{codeStep ? t('codeTitle') : t('title')}</CardTitle>
        <CardDescription>{codeStep ? t('codeDescription', { phone }) : t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {codeStep ? (
          <form action={verifyAction} className="flex flex-col gap-4">
            <input type="hidden" name="phone" value={phone} />
            <input type="hidden" name="next" value={next} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="code">{t('codeLabel')}</Label>
              <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} required />
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {t(`errors.${error}`)}
              </p>
            )}
            <Button type="submit" disabled={verifying} className="w-full">
              {verifying ? t('verifying') : t('verify')}
            </Button>
            <Link href={`/loyalty/dashboard/phone?next=${encodeURIComponent(next)}`} className="text-center text-sm font-medium text-brand-700 hover:underline">
              {t('useAnotherNumber')}
            </Link>
          </form>
        ) : (
          <form action={requestAction} className="flex flex-col gap-4">
            {status.phoneMasked && <p className="text-sm text-neutral-600">{t('onFile', { phone: status.phoneMasked })}</p>}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phone">{t('phoneLabel')}</Label>
              <Input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+96566904591" required />
              <p className="text-xs text-neutral-500">{t('phoneHint')}</p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {t(`errors.${error}`)}
              </p>
            )}
            <Button type="submit" disabled={requesting} className="w-full">
              {requesting ? t('sending') : t('sendCode')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
