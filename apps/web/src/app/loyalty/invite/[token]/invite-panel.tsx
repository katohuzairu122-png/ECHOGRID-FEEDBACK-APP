'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { AssistedInvitePreviewDto } from '@echo-grid-feedback/shared-types';
import { joinAssistedAction } from '@/lib/actions/loyalty-customer';
import { Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { PoweredByFooter } from '@/components/brand';
import { JoinConsentField } from '@/components/join-consent-field';

interface InvitePanelProps {
  token: string;
  signedIn: boolean;
  /** Present only for a signed-in customer whose invitation could be read. */
  preview: AssistedInvitePreviewDto | null;
  /** The invitation is expired, malformed, or its business or branch is gone. */
  invalid: boolean;
}

type Outcome = { kind: 'joined'; businessId: string } | { kind: 'problem'; code?: string; message?: string };

/**
 * CASHIER-AUTH-02D: the customer's side of a cashier-assisted onboarding. The customer signs in as THEMSELVES and ticks the same JOIN_LOYALTY consent
 * as every other way of joining; nothing is sent until they do (the API enforces it too). A cashier never creates or sees a customer identity.
 */
export function InvitePanel({ token, signedIn, preview, invalid }: InvitePanelProps) {
  const t = useTranslations('loyalty.customer.invite');
  const [pending, startTransition] = useTransition();
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const here = `/loyalty/invite/${token}`;

  function join() {
    if (!consentAccepted) return;
    setOutcome(null);
    startTransition(async () => {
      try {
        const result = await joinAssistedAction(token, consentAccepted);
        if (result.account) setOutcome({ kind: 'joined', businessId: result.account.businessId });
        else setOutcome({ kind: 'problem', ...(result.code !== undefined ? { code: result.code } : {}), ...(result.error !== undefined ? { message: result.error } : {}) });
      } catch {
        setOutcome({ kind: 'problem' });
      }
    });
  }

  const problemText = (code?: string) => {
    switch (code) {
      case 'ONBOARDING_INVITE_INVALID': return t('noLongerValid');
      case 'ONBOARDING_INVITE_USED': return t('used');
      case 'CONSENT_REQUIRED': return t('consentRequired');
      default: return t('genericError');
    }
  };

  let body: React.ReactNode;
  if (!signedIn) {
    body = (
      <>
        <CardHeader>
          <CardTitle>{t('signInTitle')}</CardTitle>
          <CardDescription>{t('signInBody')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Link href={`/loyalty/login?next=${encodeURIComponent(here)}`} className={buttonVariants({ size: 'lg', className: 'w-full min-h-12' })}>{t('signIn')}</Link>
          <Link href={`/loyalty/signup?next=${encodeURIComponent(here)}`} className={buttonVariants({ size: 'lg', variant: 'outline', className: 'w-full min-h-12' })}>{t('createAccount')}</Link>
        </CardContent>
      </>
    );
  } else if (outcome?.kind === 'joined') {
    body = (
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <CardTitle>{t('joinedTitle')}</CardTitle>
        <CardDescription>{preview ? t('joinedBody', { businessName: preview.businessName }) : t('joinedBodyGeneric')}</CardDescription>
        <Link href={`/loyalty/dashboard/${outcome.businessId}`} className="text-sm font-medium text-brand-700 hover:underline">{t('viewRewards')}</Link>
      </CardContent>
    );
  } else if (invalid || !preview) {
    body = (
      <CardContent role="alert" className="flex flex-col items-center gap-2 py-12 text-center">
        <CardTitle>{t('invalidTitle')}</CardTitle>
        <CardDescription>{t('invalidBody')}</CardDescription>
      </CardContent>
    );
  } else if (preview.status === 'already_member') {
    body = (
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <CardTitle>{t('alreadyMemberTitle', { businessName: preview.businessName })}</CardTitle>
        <CardDescription>{t('alreadyMemberBody')}</CardDescription>
        <Link href={`/loyalty/dashboard/${preview.businessId}`} className="text-sm font-medium text-brand-700 hover:underline">{t('viewRewards')}</Link>
      </CardContent>
    );
  } else if (preview.status === 'used') {
    body = (
      <CardContent role="alert" className="flex flex-col items-center gap-2 py-12 text-center">
        <CardTitle>{t('usedTitle')}</CardTitle>
        <CardDescription>{t('used')}</CardDescription>
      </CardContent>
    );
  } else {
    body = (
      <>
        <CardHeader>
          <CardTitle>{t('title', { businessName: preview.businessName })}</CardTitle>
          <CardDescription>{t('subtitle', { branchName: preview.branchName })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <JoinConsentField checked={consentAccepted} onChange={setConsentAccepted} disabled={pending} />
          <Button onClick={join} disabled={pending || !consentAccepted} size="lg" className="min-h-12 w-full">
            {pending ? t('joining') : t('join')}
          </Button>
          {outcome?.kind === 'problem' && (
            outcome.code === 'PHONE_VERIFICATION_REQUIRED' ? (
              <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-300 p-3">
                <p className="text-sm">{t('phoneRequired')}</p>
                <Link href={`/loyalty/dashboard/phone?next=${encodeURIComponent(here)}`} className={buttonVariants({ size: 'lg', className: 'w-full min-h-12' })}>{t('verifyPhone')}</Link>
              </div>
            ) : (
              <p role="alert" className="text-sm text-danger">{problemText(outcome.code)}</p>
            )
          )}
        </CardContent>
      </>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50 p-4 sm:p-8">
      <Card className="w-full max-w-md">{body}</Card>
      <PoweredByFooter />
    </main>
  );
}
