'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { completeCustomerEmailUpgradeAction, type CustomerEmailUpgradeState } from '@/lib/actions/customer-email-upgrade';

const initial: CustomerEmailUpgradeState = {};
const settings = '/loyalty/dashboard/settings';

function parseEmailLinkProof(fragment: string): string | null {
  const match = /^#c=([^&]+)$/.exec(fragment);
  if (!match) return null;
  try {
    const proof = decodeURIComponent(match[1]!);
    return /^[0-9a-fA-F-]{36}\.[A-Za-z0-9_-]{16,}$/.test(proof) ? proof : null;
  } catch { return null; }
}

export function CustomerEmailUpgradeVerifyForm() {
  const [state, action, pending] = useActionState(completeCustomerEmailUpgradeAction, initial);
  const [challenge, setChallenge] = useState<string | null | undefined>();
  const parsed = useRef(false);
  const t = useTranslations('loyalty.customer.settings');

  useEffect(() => {
    // Strict Mode replays effects. Do not replace the retained proof with
    // null after the first effect has scrubbed it from the address bar.
    if (parsed.current) return;
    parsed.current = true;
    setChallenge(parseEmailLinkProof(window.location.hash));
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  useEffect(() => {
    if (state.success) window.location.assign('/loyalty/login');
  }, [state]);

  if (challenge === undefined) return null;
  return (
    <main className="mx-auto w-full max-w-sm py-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('upgradeConfirmTitle')}</CardTitle>
          <CardDescription>{t('upgradeConfirmDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {challenge ? (
            <form action={action} className="flex flex-col gap-3">
              <input type="hidden" name="challenge" value={challenge} />
              <Label htmlFor="upgrade-confirm-name">{t('nameLabel')}</Label>
              <Input id="upgrade-confirm-name" name="name" autoComplete="name" maxLength={120} required />
              <Label htmlFor="upgrade-confirm-email">{t('upgradeEmailLabel')}</Label>
              <Input id="upgrade-confirm-email" type="email" autoComplete="email" name="email" required />
              <Label htmlFor="upgrade-password">{t('newPasswordLabel')}</Label>
              <Input id="upgrade-password" type="password" name="password" autoComplete="new-password" required />
              <Label htmlFor="upgrade-confirm-password">{t('confirmPasswordLabel')}</Label>
              <Input id="upgrade-confirm-password" type="password" name="passwordConfirmation" autoComplete="new-password" required />
              {state.error && <p role="alert" className="text-sm text-danger">
                {t(`upgradeErrors.${state.error}`, { min: state.minLength ?? 0 })}
              </p>}
              <Button type="submit" disabled={pending || !!state.success}>
                {pending ? t('saving') : t('upgradeComplete')}
              </Button>
              <Link href={settings} className="text-sm text-brand-700 underline">{t('upgradeBack')}</Link>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              <p role="alert">{t('upgradeMissingLink')}</p>
              <Link href={settings} className="text-sm text-brand-700 underline">{t('upgradeBack')}</Link>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
