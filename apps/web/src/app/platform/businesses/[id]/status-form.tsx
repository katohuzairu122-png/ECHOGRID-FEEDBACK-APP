'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { PlatformBusinessDto } from '@echo-grid-feedback/shared-types';
import { updateBusinessStatusAction, type PlatformActionState } from '@/lib/actions/platform';
import { Button, Label, Select, Textarea } from '@/components/ui';

const initialState: PlatformActionState = {};

interface StatusFormProps {
  business: PlatformBusinessDto;
}

/**
 * Only rendered for admins (see page.tsx -- the caller checks role before
 * mounting this at all), not re-checked here client-side. That matches this
 * app's one deliberate, consistent permission-UX convention: the real
 * enforcement is server-side (requirePlatformRole(['admin']) on
 * PATCH /:id/status), a client check would only be about not showing a
 * control that would 403 on click, and the caller already handles that.
 */
export function StatusForm({ business }: StatusFormProps) {
  const action = updateBusinessStatusAction.bind(null, business.id);
  const [state, formAction, pending] = useActionState(action, initialState);
  const t = useTranslations('platform.businesses.detail.statusForm');

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="status">{t('statusLabel')}</Label>
        <Select id="status" name="status" defaultValue={business.status} required>
          <option value="active">{t('statusActive')}</option>
          <option value="suspended">{t('statusSuspended')}</option>
          <option value="archived">{t('statusArchived')}</option>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reason">{t('reasonLabel')}</Label>
        <Textarea id="reason" name="reason" placeholder={t('reasonPlaceholder')} />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.success && <p className="text-sm text-success">{t('success')}</p>}
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t('saving') : t('submit')}
      </Button>
    </form>
  );
}
