'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { LoyaltyTierDto } from '@echo-grid-feedback/shared-types';
import { createTierAction, updateTierAction, type LoyaltyFormState } from '@/lib/actions/loyalty';
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

interface TierFormDialogProps {
  tier?: LoyaltyTierDto;
  trigger: React.ReactElement<Record<string, unknown>>;
}

/** Mirrors BranchFormDialog exactly -- same create/edit-in-one-component
 * shape, same controlled-open-closes-on-success pattern. */
export function TierFormDialog({ tier, trigger }: TierFormDialogProps) {
  const [open, setOpen] = useState(false);
  const action = tier ? updateTierAction.bind(null, tier.id) : createTierAction;
  const [state, formAction, pending] = useActionState(action, initialState);
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.staff.tierForm');

  useEffect(() => {
    if (state.success) setOpen(false);
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogTitle>{tier ? t('titleEdit') : t('titleNew')}</DialogTitle>
        <DialogDescription>
          {tier ? t('descriptionEdit', { name: tier.name }) : t('descriptionNew')}
        </DialogDescription>
        <form action={formAction} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">{t('nameLabel')}</Label>
            <Input id="name" name="name" defaultValue={tier?.name} placeholder="Gold" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="minPoints">{t('minPointsLabel')}</Label>
            <Input
              id="minPoints"
              name="minPoints"
              type="number"
              min="0"
              step="1"
              defaultValue={tier?.minPoints}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="benefits">{t('benefitsLabel')}</Label>
            <Input id="benefits" name="benefits" defaultValue={tier?.benefits ?? ''} />
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <DialogClose render={<Button type="button" variant="ghost" />}>{t('cancel')}</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? t('saving') : tier ? t('saveChanges') : t('create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
