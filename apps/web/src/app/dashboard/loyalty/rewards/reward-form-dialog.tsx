'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { LoyaltyRewardDto } from '@echo-grid-feedback/shared-types';
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
} from '@/components/ui';

const initialState: LoyaltyFormState = {};

interface RewardFormDialogProps {
  reward?: LoyaltyRewardDto;
  trigger: React.ReactElement<Record<string, unknown>>;
}

export function RewardFormDialog({ reward, trigger }: RewardFormDialogProps) {
  const [open, setOpen] = useState(false);
  const action = reward ? updateRewardAction.bind(null, reward.id) : createRewardAction;
  const [state, formAction, pending] = useActionState(action, initialState);
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
            <Label htmlFor="pointsCost">{t('pointsCostLabel')}</Label>
            <Input
              id="pointsCost"
              name="pointsCost"
              type="number"
              min="1"
              step="1"
              defaultValue={reward?.pointsCost}
              required
            />
          </div>
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
