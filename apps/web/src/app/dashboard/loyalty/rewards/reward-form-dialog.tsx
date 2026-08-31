'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { LoyaltyRewardDto, BranchDto } from '@echo-grid-feedback/shared-types';
import { createRewardAction, updateRewardAction, type LoyaltyFormState } from '@/lib/actions/loyalty';
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
  Select,
} from '@/components/ui';

const initialState: LoyaltyFormState = {};

interface RewardFormDialogProps {
  reward?: LoyaltyRewardDto;
  /** Continuing Development Block 6.8.1 (S6.1 campaign config UI) -- fetched
   * server-side by the page and passed down, same "fetch once, pass as
   * prop" pattern as dashboard/feedback/page.tsx's BranchFilter, not a
   * self-fetching component. */
  branches: BranchDto[];
  trigger: React.ReactElement<Record<string, unknown>>;
}

export function RewardFormDialog({ reward, branches, trigger }: RewardFormDialogProps) {
  const [open, setOpen] = useState(false);
  const action = reward ? updateRewardAction.bind(null, reward.id) : createRewardAction;
  const [state, formAction, pending] = useActionState(action, initialState);
  // Continuing Development Block 6.8.1 -- drives which of pointsCost/
  // rewardValue is shown; only field in this form that needs to be
  // controlled (name/description/pointsCost/branchId stay uncontrolled
  // defaultValue fields, same as before this block).
  const [type, setType] = useState<LoyaltyRewardDto['type']>(reward?.type ?? 'points');
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.staff.rewardForm');

  useEffect(() => {
    if (state.success) setOpen(false);
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogTitle>{reward ? t('titleEdit') : t('titleNew')}</DialogTitle>
        <DialogDescription>
          {reward ? t('descriptionEdit', { name: reward.name }) : t('descriptionNew')}
        </DialogDescription>
        <form action={formAction} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">{t('nameLabel')}</Label>
            <Input id="name" name="name" defaultValue={reward?.name} placeholder="Free coffee" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">{t('descriptionLabel')}</Label>
            <Input id="description" name="description" defaultValue={reward?.description ?? ''} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="type">{t('typeLabel')}</Label>
            <Select
              id="type"
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value as LoyaltyRewardDto['type'])}
            >
              <option value="points">{t('typePoints')}</option>
              <option value="discount">{t('typeDiscount')}</option>
              <option value="free_item">{t('typeFreeItem')}</option>
              <option value="voucher">{t('typeVoucher')}</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branchId">{t('branchIdLabel')}</Label>
            {/* Empty option = business-wide. The action layer (not this
                component) is what turns that empty string into an explicit
                `null` on submit -- see createRewardAction/updateRewardAction's
                own Block 6.8.1 comment for why `null`, not omission, is
                required to actually clear an already-scoped reward. */}
            <Select id="branchId" name="branchId" defaultValue={reward?.branchId ?? ''}>
              <option value="">{t('branchIdAllOption')}</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </Select>
          </div>
          {type === 'points' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pointsCost">{t('pointsCostLabel')}</Label>
              <Input
                id="pointsCost"
                name="pointsCost"
                type="number"
                min="1"
                step="1"
                // CI fix (Block 6.6): pointsCost is nullable now (non-points
                // reward types) -- same reasoning as reward-card.tsx's
                // canAfford guard. ?? undefined leaves the field empty rather
                // than passing null into an uncontrolled input's defaultValue.
                defaultValue={reward?.pointsCost ?? undefined}
                required
              />
            </div>
          )}
          {type !== 'points' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rewardValue">{t('rewardValueLabel')}</Label>
              {/* Not `required`: createRewardSchema/updateRewardSchema don't
                  hard-require rewardValue for non-points types the way they
                  do pointsCost for 'points' (no matching .refine() rule) --
                  this field shouldn't enforce a stricter rule than the API
                  actually does. rewardValue round-trips as a decimal STRING
                  on the DTO (numeric column), so reward?.rewardValue is
                  already the right shape for defaultValue with no
                  conversion. */}
              <Input
                id="rewardValue"
                name="rewardValue"
                type="number"
                min="0.01"
                step="0.01"
                defaultValue={reward?.rewardValue ?? undefined}
              />
            </div>
          )}
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <DialogClose render={<Button type="button" variant="ghost" />}>{t('cancel')}</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? t('saving') : reward ? t('saveChanges') : t('create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
