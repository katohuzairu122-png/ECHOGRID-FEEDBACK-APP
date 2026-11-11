import type { ReactNode } from 'react';
import { LandingIcon } from '@/components/landing/landing-icon';
import styles from './loyalty-catalog.module.css';

/**
 * Presentation-only card for existing authorized business tier/reward rows.
 * No inferred campaign statistics, loyalty balances, or status changes.
 */
export function LoyaltyCatalogCard({
  title,
  kind,
  details,
  status,
  actions,
}: {
  title: string;
  kind: 'tier' | 'reward';
  details: ReactNode;
  status?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <article className={styles.card} data-catalog-kind={kind} aria-label={title}>
      <div className={styles.cardBody}>
        <span className={styles.cardIcon} aria-hidden="true">
          <LandingIcon name={kind === 'tier' ? 'star' : 'gift'} width={23} height={23} />
        </span>
        <div className={styles.cardDetails}>
          <div className={styles.titleRow}>
            <h2 className={styles.itemTitle}>{title}</h2>
            {status}
          </div>
          <div className={styles.metadata}>{details}</div>
        </div>
      </div>
      <div className={styles.actions}>{actions}</div>
    </article>
  );
}
