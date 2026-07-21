'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Input } from '@/components/ui';

interface AuditFiltersProps {
  businessId?: string | undefined;
  actorUserId?: string | undefined;
  entityType?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * businessId/actorUserId are raw-UUID text inputs, not selects -- there is
 * no bounded list to pick from (potentially every business/user on the
 * platform), so a free-text field an admin pastes into (typically arriving
 * pre-filled via the "View audit log" link from a business detail page,
 * see businesses/[id]/page.tsx) is the honest choice rather than a
 * combobox pretending to search something it can't. Same combined-submit
 * reasoning as businesses/business-filters.tsx.
 */
export function AuditFilters({
  businessId,
  actorUserId,
  entityType,
  action,
  from,
  to,
}: AuditFiltersProps) {
  const router = useRouter();
  const [businessIdInput, setBusinessIdInput] = useState(businessId ?? '');
  const [actorUserIdInput, setActorUserIdInput] = useState(actorUserId ?? '');
  const [entityTypeInput, setEntityTypeInput] = useState(entityType ?? '');
  const [actionInput, setActionInput] = useState(action ?? '');
  const [fromInput, setFromInput] = useState(from ?? '');
  const [toInput, setToInput] = useState(to ?? '');
  const t = useTranslations('platform.auditLog.filters');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (businessIdInput.trim()) params.set('businessId', businessIdInput.trim());
    if (actorUserIdInput.trim()) params.set('actorUserId', actorUserIdInput.trim());
    if (entityTypeInput.trim()) params.set('entityType', entityTypeInput.trim());
    if (actionInput.trim()) params.set('action', actionInput.trim());
    if (fromInput) params.set('from', fromInput);
    if (toInput) params.set('to', toInput);
    router.push(`/platform/audit-log?${params}`);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <Field label={t('businessIdLabel')}>
        <Input
          value={businessIdInput}
          onChange={(e) => setBusinessIdInput(e.target.value)}
          placeholder={t('businessIdPlaceholder')}
          className="w-52"
        />
      </Field>
      <Field label={t('actorUserIdLabel')}>
        <Input
          value={actorUserIdInput}
          onChange={(e) => setActorUserIdInput(e.target.value)}
          placeholder={t('actorUserIdPlaceholder')}
          className="w-52"
        />
      </Field>
      <Field label={t('entityTypeLabel')}>
        <Input
          value={entityTypeInput}
          onChange={(e) => setEntityTypeInput(e.target.value)}
          placeholder={t('entityTypePlaceholder')}
          className="w-32"
        />
      </Field>
      <Field label={t('actionLabel')}>
        <Input
          value={actionInput}
          onChange={(e) => setActionInput(e.target.value)}
          placeholder={t('actionPlaceholder')}
          className="w-56"
        />
      </Field>
      <Field label={t('fromLabel')}>
        <Input type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} className="w-40" />
      </Field>
      <Field label={t('toLabel')}>
        <Input type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} className="w-40" />
      </Field>
      <Button type="submit" size="sm">
        {t('apply')}
      </Button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600">{label}</span>
      {children}
    </label>
  );
}
