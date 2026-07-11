'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { BranchDto } from '@echo-grid-feedback/shared-types';
import { createBranchAction, updateBranchAction, type BranchFormState } from '@/lib/actions/branches';
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

const initialState: BranchFormState = {};

interface BranchFormDialogProps {
  /** Present = edit mode (pre-fills the form, PATCHes on submit); absent = create mode. */
  branch?: BranchDto;
  /**
   * A single element, not arbitrary ReactNode -- Base UI's Dialog.Trigger
   * uses a `render` prop (not Radix's asChild) that clones this element and
   * merges in the trigger's own onClick/aria-* props. Passing a plain
   * ReactNode here would make Trigger render its own wrapping <button>,
   * nesting a <button> inside our <Button> below.
   */
  trigger: React.ReactElement;
}

export function BranchFormDialog({ branch, trigger }: BranchFormDialogProps) {
  const [open, setOpen] = useState(false);
  const action = branch ? updateBranchAction.bind(null, branch.id) : createBranchAction;
  const [state, formAction, pending] = useActionState(action, initialState);
  // i18n & Multi-Currency Block 5.
  const t = useTranslations('branches.form');

  // `state` starts as `{}` (no `success` key) both before any submission
  // and would stay indistinguishable from "just succeeded" without this
  // explicit flag -- see BranchFormState in lib/actions/branches.ts.
  useEffect(() => {
    if (state.success) setOpen(false);
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogTitle>{branch ? t('titleEdit') : t('titleNew')}</DialogTitle>
        <DialogDescription>
          {branch ? t('descriptionEdit', { name: branch.name }) : t('descriptionNew')}
        </DialogDescription>
        <form action={formAction} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">{t('nameLabel')}</Label>
            <Input id="name" name="name" defaultValue={branch?.name} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slug">{t('slugLabel')}</Label>
            <Input
              id="slug"
              name="slug"
              defaultValue={branch?.slug}
              pattern="[a-z0-9-]+"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="addressLine1">{t('addressLine1Label')}</Label>
              <Input id="addressLine1" name="addressLine1" defaultValue={branch?.addressLine1 ?? ''} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="addressLine2">{t('addressLine2Label')}</Label>
              <Input id="addressLine2" name="addressLine2" defaultValue={branch?.addressLine2 ?? ''} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="city">{t('cityLabel')}</Label>
              <Input id="city" name="city" defaultValue={branch?.city ?? ''} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stateProvince">{t('stateProvinceLabel')}</Label>
              <Input id="stateProvince" name="stateProvince" defaultValue={branch?.stateProvince ?? ''} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="postalCode">{t('postalCodeLabel')}</Label>
              <Input id="postalCode" name="postalCode" defaultValue={branch?.postalCode ?? ''} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="countryCode">{t('countryCodeLabel')}</Label>
              <Input
                id="countryCode"
                name="countryCode"
                defaultValue={branch?.countryCode ?? ''}
                placeholder="US"
                maxLength={2}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="timezone">{t('timezoneLabel')}</Label>
              <Input
                id="timezone"
                name="timezone"
                defaultValue={branch?.timezone}
                placeholder="America/New_York"
              />
            </div>
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <DialogClose render={<Button type="button" variant="ghost" />}>{t('cancel')}</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? t('saving') : branch ? t('saveChanges') : t('create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
