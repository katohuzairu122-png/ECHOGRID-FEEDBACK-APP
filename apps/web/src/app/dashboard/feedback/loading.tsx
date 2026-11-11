import { getTranslations } from 'next-intl/server';
import styles from './feedback-inbox.module.css';

/** Route-level loading state for the inbox: structure only, no invented data. */
export default async function FeedbackLoading() {
  const t = await getTranslations('feedback.staff');
  return (
    <div className={styles.page} role="status" aria-live="polite" aria-label={t('loadingLabel')}>
      <span className="sr-only">{t('loadingLabel')}</span>
      <div className={styles.skeleton} aria-hidden="true">
        <div style={{ height: 56, width: '40%' }} />
        <div style={{ height: 170 }} />
        <div style={{ height: 130 }} />
        <div style={{ height: 130 }} />
      </div>
    </div>
  );
}
