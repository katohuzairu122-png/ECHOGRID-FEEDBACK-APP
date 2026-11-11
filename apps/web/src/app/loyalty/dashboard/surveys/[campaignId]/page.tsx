import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSurveyCampaign } from '@/lib/surveys';
import { SurveyForm } from './survey-form';
import styles from '../surveys.module.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Take one survey campaign. The API decides eligibility (audience, repeat policy, open window). */
export default async function TakeSurveyPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const t = await getTranslations('loyalty.customer.surveys');
  const back = (
    <Link href="/loyalty/dashboard/surveys" className={styles.back}>
      {t('take.back')}
    </Link>
  );
  const load = UUID.test(campaignId) ? await getSurveyCampaign(campaignId) : { status: 'not_found' as const };
  if (load.status !== 'ready') {
    const message =
      load.status === 'not_found'
        ? t('take.notFound')
        : load.status === 'forbidden'
          ? t('take.forbidden')
          : t('take.unavailable');
    return (
      <div className={styles.page}>
        {back}
        <div className={styles.notice} role="status" data-state={load.status}>
          <p>{message}</p>
        </div>
      </div>
    );
  }
  const { version } = load.data;
  return (
    <div className={styles.page}>
      {back}
      <header className={styles.header}>
        <p className={styles.eyebrow}>{t('eyebrow')}</p>
        <h1 className="text-2xl">{version.title}</h1>
        {version.description && <p className={styles.muted}>{version.description}</p>}
      </header>
      <SurveyForm
        campaignId={campaignId}
        questions={[...version.questions].sort((a, b) => a.position - b.position)}
        participationKey={crypto.randomUUID()}
      />
    </div>
  );
}
