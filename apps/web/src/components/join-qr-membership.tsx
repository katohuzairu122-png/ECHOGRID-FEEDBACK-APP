'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { joinLoyaltyAction } from '@/lib/actions/loyalty-customer';
import { Button } from '@/components/ui';
import { JoinConsentField } from './join-consent-field';

export function JoinQrMembership({ token }: { token: string }) {
  const t = useTranslations('loyalty.customer.join');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="max-w-sm space-y-3 rounded-lg border p-4">
      <JoinConsentField checked={consent} onChange={setConsent} disabled={pending} />
      <Button
        disabled={!consent || pending}
        onClick={() =>
          start(async () => {
            setError(undefined);
            try {
              await joinLoyaltyAction(token, consent);
              router.refresh();
            } catch {
              setError(t('error'));
            }
          })
        }
      >
        {pending ? t('joining') : t('button')}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
