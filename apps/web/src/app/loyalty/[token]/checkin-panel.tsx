'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { LoyaltyAccountDto } from '@echo-grid-feedback/shared-types';
import { checkinAction } from '@/lib/actions/loyalty-customer';
import { Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { PoweredByFooter } from '@/components/brand';

interface CheckinPanelProps {
  token: string;
  branchName: string;
  businessName: string;
  signedIn: boolean;
  feedbackReceived?: boolean;
  autoCheckin?: boolean;
}

/**
 * Mirrors feedback-form.tsx's overall shape (Card, inline success state, no
 * redirect) but is a plain useTransition action, not a form -- checking in
 * has no fields to collect, just a single confirmation tap.
 */
export function CheckinPanel({ token, branchName, businessName, signedIn, feedbackReceived = false, autoCheckin = false }: CheckinPanelProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const [account, setAccount] = useState<LoyaltyAccountDto>();
  const automaticCheckinStarted = useRef(false);
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.customer.checkin');
  const feedbackT = useTranslations('feedback.submit');

  const handleCheckin = () => {
    setError(undefined);
    startTransition(async () => {
      try {
        const result = await checkinAction(token);
        if (result.error) {
          setError(result.error);
          return;
        }
        if (result.account) setAccount(result.account);
      } catch {
        setError(t('genericError'));
      }
    });
  };

  useEffect(() => {
    if (!signedIn || !autoCheckin || automaticCheckinStarted.current) return;
    automaticCheckinStarted.current = true;
    handleCheckin();
  }, [autoCheckin, signedIn]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50 p-4 sm:p-8">
      {feedbackReceived && (
        <Card className="w-full max-w-md border-brand-200 bg-brand-50">
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <CardTitle>{feedbackT('thankYouTitle')}</CardTitle>
            <CardDescription>{feedbackT('thankYouDescription', { branchName })}</CardDescription>
          </CardContent>
        </Card>
      )}
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
                  href={`/loyalty/login?next=${encodeURIComponent(`/loyalty/${token}?autocheckin=1${feedbackReceived ? '&feedback=received' : ''}`)}`}
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
