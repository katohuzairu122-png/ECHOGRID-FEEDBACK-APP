'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { LoyaltyAccountDto } from '@echo-grid-feedback/shared-types';
import { checkinAction } from '@/lib/actions/loyalty-customer';
import { ApiError } from '@/lib/api-error';
import { Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { PoweredByFooter } from '@/components/brand';

interface CheckinPanelProps {
  token: string;
  branchName: string;
  businessName: string;
  signedIn: boolean;
}

/**
 * Mirrors feedback-form.tsx's overall shape (Card, inline success state, no
 * redirect) but is a plain useTransition action, not a form -- checking in
 * has no fields to collect, just a single confirmation tap.
 */
export function CheckinPanel({ token, branchName, businessName, signedIn }: CheckinPanelProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const [account, setAccount] = useState<LoyaltyAccountDto>();
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.customer.checkin');

  const handleCheckin = () => {
    setError(undefined);
    startTransition(async () => {
      try {
        const result = await checkinAction(token);
        setAccount(result);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t('genericError'));
      }
    });
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50 p-4 sm:p-8">
      <Card className="w-full max-w-md">
        {account ? (
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <CardTitle>{t('checkedInTitle')}</CardTitle>
            <CardDescription>
              {branchName} · {businessName}
            </CardDescription>
            <p className="text-3xl font-semibold text-brand-700">{t('points', { points: account.points })}</p>
            <Link
              href={`/loyalty/dashboard/${account.businessId}`}
              className="text-sm font-medium text-brand-700 hover:underline"
            >
              {t('viewRewards')}
            </Link>
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <CardTitle>{t('welcome', { branchName })}</CardTitle>
              <CardDescription>{t('subtitle', { businessName })}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {signedIn ? (
                <Button onClick={handleCheckin} disabled={pending} size="lg" className="w-full">
                  {pending ? t('checkingIn') : t('checkIn')}
                </Button>
              ) : (
                <Link
                  href={`/loyalty/login?next=/loyalty/${token}`}
                  className={buttonVariants({ size: 'lg', className: 'w-full' })}
                >
                  {t('signInToCheckIn')}
                </Link>
              )}
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
            </CardContent>
          </>
        )}
      </Card>
      <PoweredByFooter />
    </main>
  );
}
