import type { ReactNode } from 'react';
import { Badge } from '@/components/ui';
import { LandingIcon } from '@/components/landing/landing-icon';
import styles from './loyalty-visual.module.css';

/** Presentation only: all points, status and visit data are supplied by the authorized business read. */
export function LoyaltyAccountCard({
  customer,
  visitLabel,
  lastVisitAt,
  lastVisitLabel,
  points,
  pointsLabel,
  suspended,
  suspendedLabel,
  actions,
}: {
  customer: string;
  visitLabel: string;
  lastVisitAt: string | null;
  lastVisitLabel: string;
  points: string;
  pointsLabel: string;
  suspended: boolean;
  suspendedLabel: string;
  actions: ReactNode;
}) {
  return (
    <article className={styles.accountCard} aria-label={customer}>
      <div className={styles.accountTop}>
        <div className={styles.identity}>
          <span className={styles.avatar} aria-hidden="true">
            <LandingIcon name="star" width={23} height={23} />
          </span>
          <div>
            <h2 className={styles.customerName}>{customer}</h2>
            <p className={styles.visitLine}>
              {visitLabel} ·{' '}
              {lastVisitAt ? (
                <time dateTime={lastVisitAt}>{lastVisitLabel}</time>
              ) : (
                <span>{lastVisitLabel}</span>
              )}
            </p>
          </div>
        </div>
        {suspended && <Badge variant="neutral">{suspendedLabel}</Badge>}
      </div>
      <div className={styles.accountBottom}>
        <div className={styles.points}>
          <span className={styles.pointsLabel}>{pointsLabel}</span>
          <strong className={styles.pointsValue}>{points}</strong>
        </div>
        <div className={styles.actions}>{actions}</div>
      </div>
    </article>
  );
}
