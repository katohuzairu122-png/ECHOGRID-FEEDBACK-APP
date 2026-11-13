'use client';

import { useTranslations } from 'next-intl';
import { useUnreadCount, useUnreadTotal, type UnreadSource } from '@/lib/unread-store';
import styles from './workspace.module.css';

const display = (count: number) => (count > 99 ? '99+' : String(count));

/**
 * The count pill on a menu item, WhatsApp style. The number is decoration for sighted users; screen readers get the
 * sentence instead, once, as part of the link's name, and the badge is never a live region so a refresh does not
 * interrupt anyone. Renders nothing at zero.
 */
export function NavUnreadBadge({ source }: { source: UnreadSource }) {
  const count = useUnreadCount(source);
  const t = useTranslations('common.workspace');
  if (count <= 0) return null;
  return (
    <>
      <span className={styles.navBadge} aria-hidden="true" data-unread-badge="">
        {display(count)}
      </span>
      <span className="sr-only">{t('unreadMessages', { count })}</span>
    </>
  );
}

/** A small dot on the "More" button when something unread is hidden inside the sheet on a small screen. */
export function NavUnreadDot({ sources }: { sources: readonly UnreadSource[] }) {
  const total = useUnreadTotal(sources);
  const t = useTranslations('common.workspace');
  if (total <= 0) return null;
  return (
    <>
      <span className={styles.navDot} aria-hidden="true" data-unread-dot="" />
      <span className="sr-only">{t('unreadMessages', { count: total })}</span>
    </>
  );
}
