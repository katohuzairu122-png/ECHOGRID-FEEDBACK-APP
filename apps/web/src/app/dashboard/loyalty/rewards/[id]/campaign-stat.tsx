import type { ReactNode } from 'react';
import styles from './campaign-detail.module.css';

/** Read-only metric presentation: the parent supplies authoritative API values and localized labels. */
export function CampaignStat({
  label,
  value,
  hint,
  tone = 'mint',
}: {
  label: string;
  value: ReactNode;
  hint?: string | undefined;
  tone?: 'mint' | 'cyan' | 'violet';
}) {
  return (
    <div className={styles.stat} data-tone={tone}>
      <dt className={styles.statLabel}>{label}</dt>
      <dd className={styles.statValue}>{value}</dd>
      {hint && <dd className={styles.statHint}>{hint}</dd>}
    </div>
  );
}
