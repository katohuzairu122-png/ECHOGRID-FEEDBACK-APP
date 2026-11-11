'use client';

import { useId, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from '@echo-grid-feedback/shared-types';
import { Select } from '@/components/ui';
import { setLanguageAction } from '@/lib/actions/language';

/**
 * The single shared language selector for customer and public surfaces.
 * Each language is shown in its own name (not translated). Choosing one saves
 * it (cookie, plus the customer's account when signed in) and refreshes.
 */
export function LanguageSelector({ className }: { className?: string }) {
  const t = useTranslations('common.language');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const id = useId();

  return (
    <div className={className}>
      <label htmlFor={id} className="sr-only">
        {t('label')}
      </label>
      <Select
        id={id}
        value={locale}
        disabled={pending}
        aria-busy={pending}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(async () => {
            const result = await setLanguageAction(next);
            if (result.ok) router.refresh();
          });
        }}
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code} lang={code}>
            {LOCALE_LABELS[code]}
          </option>
        ))}
      </Select>
    </div>
  );
}
