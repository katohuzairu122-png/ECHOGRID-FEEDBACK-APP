'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import styles from '../community-sections.module.css';

/** Refresh the current server-rendered page through its existing customer authorization. */
export function FeedRefreshButton({ retry = false }: { retry?: boolean }) {
  const router = useRouter();
  const t = useTranslations('loyalty.customer.community.feed');
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className={styles.action}
      disabled={pending}
      aria-busy={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? t('refreshing') : t(retry ? 'retry' : 'refresh')}
    </button>
  );
}
