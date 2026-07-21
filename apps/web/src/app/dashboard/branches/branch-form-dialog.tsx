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
  trigger: React.ReactElement<Record<string, unknown>>;
}

export function BranchFormDialog({ branch, trigger }: BranchFormDialogProps) {
  const [open, setOpen] = useState(false);
  const action = branch ? updateBranchAction.bind(null, branch.id) : createBranchAction;
  const [state, formAction, pending] = useActionState(action, initialState);
  // i18n & Multi-Currency Block 5.
  const t = useTranslations('branches.form');

  // Controlled inputs (seeded from the branch in edit mode). React 19 resets
  // an uncontrolled `<form action>` once the action resolves -- on a failed
  // submit that would wipe everything the user typed while the dialog stays
  // open. Driving the values from state keeps them across that re-render.
  const [values, setValues] = useState({
    name: branch?.name ?? '',
    slug: branch?.slug ?? '',
    addressLine1: branch?.addressLine1 ?? '',
    addressLine2: branch?.addressLine2 ?? '',
    city: branch?.city ?? '',
    stateProvince: branch?.stateProvince ?? '',
    postalCode: branch?.postalCode ?? '',
    countryCode: branch?.countryCode ?? '',
    timezone: branch?.timezone ?? '',
  });
  const setField =
    (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setValues((v) => ({ ...v, [key]: e.target.value }));

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
            <Input id="name" name="name" value={values.name} onChange={setField('name')} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slug">{t('slugLabel')}</Label>
            <Input
              id="slug"
              name="slug"
              value={values.slug}
              onChange={setField('slug')}
              pattern="[a-z0-9-]+"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="addressLine1">{t('addressLine1Label')}</Label>
              <Input id="addressLine1" name="addressLine1" value={values.addressLine1} onChange={setField('addressLine1')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="addressLine2">{t('addressLine2Label')}</Label>
              <Input id="addressLine2" name="addressLine2" value={values.addressLine2} onChange={setField('addressLine2')} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="city">{t('cityLabel')}</Label>
              <Input id="city" name="city" value={values.city} onChange={setField('city')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stateProvince">{t('stateProvinceLabel')}</Label>
              <Input id="stateProvince" name="stateProvince" value={values.stateProvince} onChange={setField('stateProvince')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="postalCode">{t('postalCodeLabel')}</Label>
              <Input id="postalCode" name="postalCode" value={values.postalCode} onChange={setField('postalCode')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="countryCode">{t('countryCodeLabel')}</Label>
              <Input
                id="countryCode"
                name="countryCode"
                value={values.countryCode}
                onChange={setField('countryCode')}
                placeholder="US"
                maxLength={2}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="timezone">{t('timezoneLabel')}</Label>
              <Input
                id="timezone"
                name="timezone"
                value={values.timezone}
                onChange={setField('timezone')}
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
