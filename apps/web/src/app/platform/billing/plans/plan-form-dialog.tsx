'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PlatformSubscriptionPlanDto } from '@echo-grid-feedback/shared-types';
import {
  createPlanAction,
  updatePlanAction,
  type PlatformBillingActionState,
} from '@/lib/actions/platform-billing';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Switch,
  Textarea,
} from '@/components/ui';

const initialState: PlatformBillingActionState = {};

interface PlanFormDialogProps {
  plan?: PlatformSubscriptionPlanDto;
  trigger: React.ReactElement;
}

/** Mirrors TierFormDialog exactly -- same create/edit-in-one-component
 * shape, same controlled-open-closes-on-success pattern. Only rendered
 * behind a trigger the caller (plans/page.tsx) already gates to billing/admin
 * platformRole -- the real enforcement is server-side
 * (requirePlatformRole(['billing', 'admin']) on POST/PATCH), same
 * client-just-avoids-showing-a-control-that-would-403 convention as
 * StatusForm/ImpersonateButton. */
export function PlanFormDialog({ plan, trigger }: PlanFormDialogProps) {
  const [open, setOpen] = useState(false);
  const action = plan ? updatePlanAction.bind(null, plan.id) : createPlanAction;
  const [state, formAction, pending] = useActionState(action, initialState);
  const t = useTranslations('platform.billing.planForm');

  useEffect(() => {
    if (state.success) setOpen(false);
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogTitle>{plan ? t('titleEdit') : t('titleNew')}</DialogTitle>
        <DialogDescription>{plan ? t('descriptionEdit', { name: plan.name }) : t('descriptionNew')}</DialogDescription>
        <form action={formAction} className="mt-4 flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="key">{t('keyLabel')}</Label>
            <Input id="key" name="key" defaultValue={plan?.key} placeholder="growth" disabled={!!plan} required />
            {plan && <p className="text-xs text-neutral-500">{t('keyImmutableHint')}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">{t('nameLabel')}</Label>
            <Input id="name" name="name" defaultValue={plan?.name} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">{t('descriptionLabel')}</Label>
            <Textarea id="description" name="description" defaultValue={plan?.description ?? ''} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="priceMonthlyDollars">{t('priceMonthlyLabel')}</Label>
              <Input
                id="priceMonthlyDollars"
                name="priceMonthlyDollars"
                type="number"
                min="0"
                step="0.01"
                defaultValue={plan ? plan.priceMonthlyCents / 100 : undefined}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="priceYearlyDollars">{t('priceYearlyLabel')}</Label>
              <Input
                id="priceYearlyDollars"
                name="priceYearlyDollars"
                type="number"
                min="0"
                step="0.01"
                defaultValue={plan?.priceYearlyCents != null ? plan.priceYearlyCents / 100 : undefined}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="currency">{t('currencyLabel')}</Label>
            <Input id="currency" name="currency" defaultValue={plan?.currency ?? 'usd'} maxLength={3} className="w-24" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stripePriceIdMonthly">{t('stripePriceIdMonthlyLabel')}</Label>
              <Input
                id="stripePriceIdMonthly"
                name="stripePriceIdMonthly"
                defaultValue={plan?.stripePriceIdMonthly ?? ''}
                placeholder="price_..."
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stripePriceIdYearly">{t('stripePriceIdYearlyLabel')}</Label>
              <Input
                id="stripePriceIdYearly"
                name="stripePriceIdYearly"
                defaultValue={plan?.stripePriceIdYearly ?? ''}
                placeholder="price_..."
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="maxBranches">{t('maxBranchesLabel')}</Label>
              <Input
                id="maxBranches"
                name="maxBranches"
                type="number"
                min="0"
                step="1"
                defaultValue={plan?.maxBranches ?? ''}
                placeholder={t('unlimitedPlaceholder')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="maxUsers">{t('maxUsersLabel')}</Label>
              <Input
                id="maxUsers"
                name="maxUsers"
                type="number"
                min="0"
                step="1"
                defaultValue={plan?.maxUsers ?? ''}
                placeholder={t('unlimitedPlaceholder')}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sortOrder">{t('sortOrderLabel')}</Label>
            <Input
              id="sortOrder"
              name="sortOrder"
              type="number"
              step="1"
              defaultValue={plan?.sortOrder ?? 0}
              className="w-24"
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="isActive">{t('isActiveLabel')}</Label>
            <Switch id="isActive" name="isActive" defaultChecked={plan ? plan.isActive : true} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="isDefaultTrial">{t('isDefaultTrialLabel')}</Label>
            <Switch id="isDefaultTrial" name="isDefaultTrial" defaultChecked={plan?.isDefaultTrial ?? false} />
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <DialogClose render={<Button type="button" variant="ghost" />}>{t('cancel')}</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? t('saving') : plan ? t('saveChanges') : t('create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
