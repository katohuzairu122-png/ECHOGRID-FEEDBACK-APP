import styles from './workspace.module.css';

export interface SentimentCounts {
  total: number;
  positive: number;
  neutral: number;
  negative: number;
}

type SentimentKind = 'negative' | 'neutral' | 'positive';

const KINDS: readonly SentimentKind[] = ['negative', 'neutral', 'positive'];

/**
 * A visual breakdown of already-authorized, classified feedback.
 * No independent fetch, invented metrics, or empty-data percentages.
 */
export function SentimentBreakdown({
  totals,
  labels,
  formatCount,
  formatRate,
}: {
  totals: SentimentCounts;
  labels: Record<SentimentKind, string>;
  formatCount: (value: number) => string;
  formatRate: (fraction: number) => string;
}) {
  if (totals.total <= 0) return null;

  return (
    <ul className={styles.sentimentCards}>
      {KINDS.map((kind) => (
        <li key={kind} className={styles.sentimentCard} data-sentiment={kind}>
          <div className={styles.sentimentLabel}>
            <span className={styles.sentimentDot} aria-hidden="true" />
            <span>{labels[kind]}</span>
          </div>
          <div className={styles.sentimentValues}>
            <strong className={styles.sentimentCount}>{formatCount(totals[kind])}</strong>
            <span className={styles.sentimentRate}>
              {formatRate(totals[kind] / totals.total)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
