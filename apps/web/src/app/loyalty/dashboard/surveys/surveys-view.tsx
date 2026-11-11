import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import type { SurveyParticipationRow, SurveysHubData } from '@/lib/surveys-types';
import styles from './surveys.module.css';

const PAGE_SIZE = 20;

function ParticipationItem({ row }: { row: SurveyParticipationRow }) {
  const t = useTranslations('loyalty.customer.surveys');
  const format = useFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), 'short');
  const when =
    row.completedAt
      ? t('completedOn', { date: date(row.completedAt) })
      : row.submittedAt
        ? t('submittedOn', { date: date(row.submittedAt) })
        : t('startedOn', { date: date(row.startedAt) });
  return (
    <li className={styles.row}>
      <div>
        <p className={styles.rowTitle}>
          {row.businessName ? t('atBusiness', { business: row.businessName }) : t('surveyFallback')}
        </p>
        <p className={styles.rowMeta}>{when}</p>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span className={styles.badge} data-status={row.status}>
          {t(`status.${row.status}`)}
        </span>
        {row.status === 'started' && (
          <Link href={`/loyalty/dashboard/surveys/${row.campaignId}`}>{t('continue')}</Link>
        )}
      </div>
    </li>
  );
}

export function SurveysView({
  data,
  basePath = '/loyalty/dashboard/surveys',
}: {
  data: SurveysHubData;
  basePath?: string;
}) {
  const t = useTranslations('loyalty.customer.surveys');
  const section = data.participations;
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>{t('eyebrow')}</p>
        <h1 className="text-2xl">{t('title')}</h1>
        <p className={styles.muted}>{t('subtitle')}</p>
      </header>
      <section aria-labelledby="surveys-history">
        <h2 id="surveys-history" className="mb-2 text-lg font-semibold">
          {t('historyTitle')}
        </h2>
        {section.status !== 'ready' ? (
          <div className={styles.notice} role="status" data-state={section.status}>
            <p>{section.status === 'forbidden' ? t('forbidden') : t('unavailable')}</p>
            {section.status === 'unavailable' && <Link href={basePath}>{t('retry')}</Link>}
          </div>
        ) : section.data.items.length === 0 && section.data.offset === 0 ? (
          <div className={styles.empty}>
            <p className="font-semibold">{t('emptyTitle')}</p>
            <p>{t('emptyDescription')}</p>
          </div>
        ) : (
          <>
            <ul className={styles.list}>
              {section.data.items.map((row) => (
                <ParticipationItem key={row.id} row={row} />
              ))}
            </ul>
            {(section.data.offset > 0 || section.data.hasMore) && (
              <nav className={styles.pager} aria-label={t('pagination')}>
                {section.data.offset > 0 ? (
                  <Link
                    href={
                      section.data.offset - PAGE_SIZE > 0
                        ? `${basePath}?offset=${section.data.offset - PAGE_SIZE}`
                        : basePath
                    }
                  >
                    {t('newer')}
                  </Link>
                ) : (
                  <span />
                )}
                {section.data.hasMore && (
                  <Link href={`${basePath}?offset=${section.data.offset + PAGE_SIZE}`}>
                    {t('older')}
                  </Link>
                )}
              </nav>
            )}
          </>
        )}
      </section>
    </div>
  );
}
