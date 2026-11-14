'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  applyCustomerSanctionAction,
  type CustomerSanctionState,
} from '@/lib/actions/platform-customers';
import { Button, Input, Label, Select, Textarea } from '@/components/ui';

const initialState: CustomerSanctionState = {};

/**
 * Only mounted for admins (page.tsx checks the role first). The real
 * enforcement is server-side: requirePlatformRole(['admin']) plus the
 * warning-before-suspension rule on POST /:id/sanctions.
 */
export function SanctionForm({ customerId }: { customerId: string }) {
  const [state, formAction, pending] = useActionState(
    applyCustomerSanctionAction.bind(null, customerId),
    initialState,
  );
  const [action, setAction] = useState('warning');
  const t = useTranslations('platform.customers.detail.form');

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="action">{t('actionLabel')}</Label>
        <Select
          id="action"
          name="action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          required
        >
          <option value="warning">{t('warning')}</option>
          <option value="limit">{t('limit')}</option>
          <option value="suspend">{t('suspend')}</option>
          <option value="ban">{t('ban')}</option>
          <option value="lift">{t('lift')}</option>
        </Select>
      </div>
      {(action === 'suspend' || action === 'limit') && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="days">{t('daysLabel')}</Label>
          <Input id="days" name="days" type="number" min={1} max={365} step={1} required />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reason">{t('reasonLabel')}</Label>
        <Textarea
          id="reason"
          name="reason"
          required
          minLength={5}
          maxLength={500}
          placeholder={t('reasonPlaceholder')}
        />
      </div>
      {(action === 'limit' || action === 'suspend' || action === 'ban') && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="skipWarning" className="mt-1" />
          <span>{t('skipWarning')}</span>
        </label>
      )}
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
