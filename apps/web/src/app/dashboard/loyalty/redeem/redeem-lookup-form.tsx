'use client';

import { useActionState, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  lookupRedemptionAction,
  confirmRedemptionAction,
  type RedemptionLookupState,
} from '@/lib/actions/loyalty';
import { ApiError } from '@/lib/api-error';
import { Badge, Button, Card, CardContent, Input, Label } from '@/components/ui';

const initialState: RedemptionLookupState = {};

/**
 * The staff counter tool: type the code a customer shows on their phone,
 * see what it's for, confirm the handoff. Two separate operations
 * (lookup, confirm) rather than one combined submit -- a staff member
 * should see WHAT they're confirming (which reward, how many points)
 * before committing, not confirm blind on a single button press.
 */
export function RedeemLookupForm() {
  const [state, formAction, lookupPending] = useActionState(lookupRedemptionAction, initialState);
  const [confirmPending, startTransition] = useTransition();
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.staff.redeemForm');

  const handleConfirm = () => {
    if (!state.transaction) return;
    setConfirmError(undefined);
    startTransition(async () => {
      try {
        await confirmRedemptionAction(state.transaction!.redemptionCode!);
        setConfirmed(true);
      } catch (err) {
        setConfirmError(err instanceof ApiError ? err.message : t('confirmError'));
      }
    });
  };

  const alreadyConfirmed = confirmed || Boolean(state.transaction?.redemptionConfirmedAt);

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex items-end gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="code">{t('codeLabel')}</Label>
          <Input id="code" name="code" placeholder="ABC23XYZ" maxLength={8} required className="uppercase" />
        </div>
        <Button type="submit" disabled={lookupPending}>
          {lookupPending ? t('lookingUp') : t('lookUp')}
        </Button>
      </form>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      {state.transaction && (
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <div>
              <p className="font-medium text-neutral-900">
                {t('pointsRedeemed', { points: Math.abs(state.transaction.points) })}
              </p>
              <p className="text-xs text-neutral-500">
                {t('codePrefix', { code: state.transaction.redemptionCode ?? '' })}
              </p>
            </div>
            {alreadyConfirmed ? (
              <Badge variant="brand">{t('confirmed')}</Badge>
            ) : (
              <Button type="button" onClick={handleConfirm} disabled={confirmPending}>
                {confirmPending ? t('confirming') : t('confirmHandoff')}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      {confirmError && (
        <p role="alert" className="text-sm text-danger">
          {confirmError}
        </p>
      )}
    </div>
  );
}
