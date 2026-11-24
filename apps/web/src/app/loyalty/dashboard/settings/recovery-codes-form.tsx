'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Input, Label } from '@/components/ui';
import {
  issueCustomerRecoveryCodesAction,
  revokeCustomerRecoveryCodesAction,
  type RecoveryCodesState,
} from '@/lib/actions/customer-recovery';

const initial: RecoveryCodesState = {};

export function CustomerRecoveryCodesForm() {
  const [issued, issue, issuePending] = useActionState(issueCustomerRecoveryCodesAction, initial);
  const [revoked, revoke, revokePending] = useActionState(
    revokeCustomerRecoveryCodesAction,
    initial,
  );
  const t = useTranslations('loyalty.customer.accountRecovery');
  return (
    <div className="flex flex-col gap-5">
      <form action={issue} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="recovery-codes-password">{t('reauthPassword')}</Label>
          <Input
            id="recovery-codes-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <Button type="submit" disabled={issuePending}>
          {issuePending ? t('working') : t('issueRecoveryCodes')}
        </Button>
        {issued.error && (
          <p role="alert" className="text-sm text-danger">
            {t(`errors.${issued.error}`)}
          </p>
        )}
      </form>
      {issued.codes && (
        <section aria-live="polite" className="rounded-md border border-amber-300 bg-amber-50 p-4">
          <h3 className="font-semibold">{t('saveCodesTitle')}</h3>
          <p className="mt-1 text-sm">{t('saveCodesDescription')}</p>
          <ol className="mt-3 grid gap-2 font-mono text-sm sm:grid-cols-2">
            {issued.codes.map((code) => (
              <li key={code} className="rounded border bg-white p-2">
                {code}
              </li>
            ))}
          </ol>
        </section>
      )}
      <form action={revoke} className="flex flex-col gap-3 border-t pt-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="revoke-recovery-password">{t('reauthPassword')}</Label>
          <Input
            id="revoke-recovery-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        {revoked.revoked && (
          <p role="status" className="text-sm">
            {t('codesRevoked')}
          </p>
        )}
        {revoked.error && (
          <p role="alert" className="text-sm text-danger">
            {t(`errors.${revoked.error}`)}
          </p>
        )}
        <Button type="submit" variant="outline" disabled={revokePending}>
          {revokePending ? t('working') : t('revokeRecoveryCodes')}
        </Button>
      </form>
    </div>
  );
}
