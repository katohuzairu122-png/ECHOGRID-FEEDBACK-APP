'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { impersonateAction, type PlatformActionState } from '@/lib/actions/platform';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Label,
  Textarea,
} from '@/components/ui';

const initialState: PlatformActionState = {};

interface ImpersonateButtonProps {
  businessId: string;
  userId: string;
  userName: string;
}

/**
 * Dialog-gated, not a bare click -- impersonation assumes another user's
 * full identity, the highest-blast-radius action in the console (see
 * business-directory.routes.ts's POST /:id/impersonate comment), so it gets
 * at least the same friction as a destructive delete (DeleteBranchButton's
 * confirm()), upgraded to a real dialog since a mandatory reason needs a
 * text field, not just a yes/no. `required` on the textarea is a UX nicety;
 * the real validation is server-side (impersonateSchema).
 *
 * On success, impersonateAction redirects the whole browser into the
 * impersonated session (see lib/session.ts's startImpersonation) -- there's
 * no "close the dialog and stay here" success path to handle.
 */
export function ImpersonateButton({ businessId, userId, userName }: ImpersonateButtonProps) {
  const [open, setOpen] = useState(false);
  const action = impersonateAction.bind(null, businessId);
  const [state, formAction, pending] = useActionState(action, initialState);
  const t = useTranslations('platform.businesses.detail.impersonate');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
        {t('button')}
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>{t('title', { name: userName })}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <form action={formAction} className="mt-4 flex flex-col gap-4">
          <input type="hidden" name="userId" value={userId} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`reason-${userId}`}>{t('reasonLabel')}</Label>
            <Textarea
              id={`reason-${userId}`}
              name="reason"
              placeholder={t('reasonPlaceholder')}
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
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? t('starting') : t('confirm')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
