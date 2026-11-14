'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';

/** Cashier-scoped error boundary: a failed screen never exposes internals and the session is untouched. */
export default function CashierError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('cashier.error');
  return (
    <main role="alert" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-bold">{t('title')}</h1>
      <p className="text-sm text-neutral-600">{t('body')}</p>
      <Button type="button" onClick={reset} className="min-h-12">
        {t('retry')}
      </Button>
    </main>
  );
}
