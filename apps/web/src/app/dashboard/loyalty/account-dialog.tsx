'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  recordPurchaseAction,
  adjustPointsAction,
  type LoyaltyFormState,
} from '@/lib/actions/loyalty';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
} from '@/components/ui';

const initialState: LoyaltyFormState = {};

interface AccountDialogProps {
  accountId: string;
  customerLabel: string;
}

/**
 * One dialog, two forms (purchase / adjust) toggled by a local tab-like
 * button pair -- not a full Tabs primitive (none exists yet, and this is
 * the only place in the app that would use one so far; introducing a
 * general Tabs component for a single two-way toggle would be premature).
 * Both forms close the dialog on success via a plain useState `open` flag
 * (Base UI's Dialog is uncontrolled by default; controlling `open` here is
 * what lets a successful submission dismiss it programmatically).
 */
export function AccountDialog({ accountId, customerLabel }: AccountDialogProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'purchase' | 'adjust'>('purchase');

  const [purchaseState, purchaseAction, purchasePending] = useActionState(
    recordPurchaseAction.bind(null, accountId),
    initialState,
  );
  const [adjustState, adjustFormAction, adjustPending] = useActionState(
    adjustPointsAction.bind(null, accountId),
    initialState,
  );
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.staff.accountDialog');

  // Mirrors BranchFormDialog's pattern exactly -- {} (no `success` key) is
  // indistinguishable from "just submitted successfully" without this
  // explicit flag, and closing must happen in an effect, not during render.
  useEffect(() => {
    if (purchaseState.success || adjustState.success) setOpen(false);
  }, [purchaseState, adjustState]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
        {t('manageTrigger')}
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>{customerLabel}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>

        <div className="mt-4 flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === 'purchase' ? 'primary' : 'outline'}
            onClick={() => setMode('purchase')}
          >
            {t('purchaseTab')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'adjust' ? 'primary' : 'outline'}
            onClick={() => setMode('adjust')}
          >
            {t('adjustTab')}
          </Button>
        </div>

        {mode === 'purchase' ? (
          <form action={purchaseAction} className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="purchaseAmount">{t('purchaseAmountLabel')}</Label>
              <Input
                id="purchaseAmount"
                name="purchaseAmount"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </div>
            {purchaseState.error && (
              <p role="alert" className="text-sm text-danger">
                {purchaseState.error}
              </p>
            )}
            <Button type="submit" disabled={purchasePending}>
              {purchasePending ? t('recording') : t('recordPurchase')}
            </Button>
          </form>
        ) : (
          <form action={adjustFormAction} className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="points">{t('pointsLabel')}</Label>
              <Input id="points" name="points" type="number" step="1" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">{t('reasonLabel')}</Label>
              <Input id="notes" name="notes" maxLength={500} />
            </div>
            {adjustState.error && (
              <p role="alert" className="text-sm text-danger">
                {adjustState.error}
              </p>
            )}
            <Button type="submit" disabled={adjustPending}>
              {adjustPending ? t('saving') : t('saveAdjustment')}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
