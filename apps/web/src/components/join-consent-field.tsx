'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';

interface JoinConsentFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/**
 * The JOIN_LOYALTY consent control. Every screen that can create a membership
 * renders this one component, so the wording the customer reads cannot drift
 * between them; the version recorded with the grant is
 * CURRENT_JOIN_LOYALTY_CONSENT_VERSION, sent by joinLoyaltyAction. The API
 * refuses a join that was not explicitly accepted, so this is the visible
 * half of a rule the server enforces.
 */
export function JoinConsentField({ checked, onChange, disabled = false }: JoinConsentFieldProps) {
  const t = useTranslations('loyalty.customer.join');
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{t('consentLabel')}</span>
    </label>
  );
}
