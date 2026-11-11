import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { LandingIcon } from '@/components/landing/landing-icon';
import type {
  CommunityHubData,
  CommunityTransactionDto,
  HubSection,
} from '@/lib/community-hub-types';
import { membershipKind, membershipStatusDate } from '@/lib/community-hub-view';
import styles from './community.module.css';

type Tone = 'mint' | 'violet' | 'warning' | 'neutral' | 'danger';

/** An explicit unavailable/forbidden state: never rendered as an empty or zero value. */
function SectionNotice({
  section,
  unavailable,
  forbidden,
  retryHref,
  retryLabel,
}: {
  section: Exclude<HubSection<unknown>, { status: 'ready' }>;
  unavailable: string;
  forbidden: string;
  retryHref: string;
  retryLabel: string;
}) {
  return (
    <div className={styles.notice} role="status" data-state={section.status}>
      <p>{section.status === 'forbidden' ? forbidden : unavailable}</p>
      {section.status === 'unavailable' && <Link href={retryHref}>{retryLabel}</Link>}
    </div>
  );
}

export function CommunityHubView({
  data,
  basePath = '/loyalty/dashboard/community',
}: {
  data: CommunityHubData;
  basePath?: string;
}) {
  const t = useTranslations('loyalty.customer.community');
  const format = useFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), 'short');
  const retryProps = { retryHref: basePath, retryLabel: t('retry') };

  // ---- membership ----
  const membershipSection = data.membership;
  const membership =
    membershipSection.status === 'ready' ? membershipSection.data.membership : null;
  const kind = membershipKind(membership);
  const statusDate = membershipStatusDate(membership);
  const dateKey = kind === 'left' ? 'leftOn' : kind === 'suspended' ? 'suspendedOn' : 'activeOn';
  const membershipTone: Tone =
    kind === 'active'
      ? 'mint'
      : kind === 'suspended'
        ? 'warning'
        : kind === 'left'
          ? 'neutral'
          : 'violet';

  // ---- points ----
  const pointsSection = data.points;
  const account = pointsSection.status === 'ready' ? pointsSection.data.account : null;

  // ---- activity ----
  const activity = data.transactions;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <p className={styles.muted}>{t('description')}</p>
      </header>

      <div className={styles.hero}>
        <section className={styles.pointsCard} aria-labelledby="community-points-title">
          <span className={styles.iconTile} aria-hidden="true">
            <LandingIcon name="gift" width={26} height={26} />
          </span>
          <div className={styles.pointsBody}>
            <h2 id="community-points-title" className={styles.cardLabel}>
              {t('points.title')}
            </h2>
            {pointsSection.status !== 'ready' ? (
              <SectionNotice
                section={pointsSection}
                unavailable={t('points.unavailable')}
                forbidden={t('points.forbidden')}
                {...retryProps}
              />
            ) : account ? (
              <>
                <p className={styles.balance} data-testid="community-balance">
                  {format.number(account.pointsBalance)}
                </p>
                <p className={styles.muted}>{t('points.balanceHint')}</p>
                {account.status !== 'active' && (
                  <p className={styles.badgeRow}>
                    <span className={styles.badge} data-tone="warning">
                      {t('points.accountStatus', { status: t(`accountStatus.${account.status}`) })}
                    </span>
                  </p>
                )}
                {account.status === 'suspended' && (
                  <p className={styles.muted}>{t('points.accountSuspendedNote')}</p>
                )}
              </>
            ) : (
              <p className={styles.muted}>{t('points.noAccount')}</p>
            )}
            <p className={styles.fineprint}>{t('points.info')}</p>
          </div>
        </section>

        <section className={styles.membershipCard} aria-labelledby="community-membership-title">
          <span className={styles.iconTile} data-tone="violet" aria-hidden="true">
            <LandingIcon name="users" width={26} height={26} />
          </span>
          <div className={styles.pointsBody}>
            <h2 id="community-membership-title" className={styles.cardLabel}>
              {t('membership.title')}
            </h2>
            {membershipSection.status !== 'ready' ? (
              <SectionNotice
                section={membershipSection}
                unavailable={t('membership.unavailable')}
                forbidden={t('membership.forbidden')}
                {...retryProps}
              />
            ) : (
              <>
                <p className={styles.badgeRow}>
                  <span
                    className={styles.badge}
                    data-tone={membershipTone}
                    data-testid="membership-status"
                  >
                    {t(`membership.status.${kind}`)}
                  </span>
                </p>
                {kind === 'absent' ? (
                  <p className={styles.muted}>{t('membership.absentHint')}</p>
                ) : (
                  <>
                    {statusDate && (
                      <p className={styles.muted}>
                        {t(`membership.${dateKey}`, { date: date(statusDate) })}
                      </p>
                    )}
                    {membership && (
                      <p className={styles.fineprint}>
                        {t('membership.policyVersion', { version: membership.policyVersion })}
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <section className={styles.panel} aria-labelledby="community-activity-title">
        <div className={styles.panelHeading}>
          <div>
            <h2 id="community-activity-title">{t('activity.title')}</h2>
            <p className={styles.muted}>{t('activity.description')}</p>
          </div>
          {activity.status === 'ready' && activity.data.items.length > 0 && (
            <p className={styles.count}>
              {t('activity.showing', { count: activity.data.items.length })}
            </p>
          )}
        </div>
        {activity.status !== 'ready' ? (
          <SectionNotice
            section={activity}
            unavailable={t('activity.unavailable')}
            forbidden={t('activity.forbidden')}
            {...retryProps}
          />
        ) : activity.data.items.length === 0 ? (
          <p className={styles.empty}>{t('activity.empty')}</p>
        ) : (
          <>
            <ul className={styles.list}>
              {activity.data.items.map((item) => (
                <TransactionRow
                  key={item.id}
                  item={item}
                  business={item.businessId ? data.businessNames[item.businessId] : undefined}
                />
              ))}
            </ul>
            {(activity.data.offset > 0 || activity.data.hasMore) && (
              <nav className={styles.pager} aria-label={t('activity.pageLabel')}>
                {activity.data.offset > 0 && (
                  <Link
                    href={
                      activity.data.offset - activity.data.limit > 0
                        ? `${basePath}?offset=${activity.data.offset - activity.data.limit}`
                        : basePath
                    }
                  >
                    {t('activity.newer')}
                  </Link>
                )}
                {activity.data.hasMore && (
                  <Link href={`${basePath}?offset=${activity.data.offset + activity.data.limit}`}>
                    {t('activity.older')}
                  </Link>
                )}
              </nav>
            )}
          </>
        )}
      </section>

      <div className={styles.about}>
        <section className={styles.panel}>
          <h2>{t('about.membershipTitle')}</h2>
          <p className={styles.muted}>{t('about.membershipBody')}</p>
        </section>
        <section className={styles.panel}>
          <h2>{t('about.pointsTitle')}</h2>
          <p className={styles.muted}>{t('about.pointsBody')}</p>
        </section>
      </div>
    </div>
  );
}

function TransactionRow({
  item,
  business,
}: {
  item: CommunityTransactionDto;
  business: string | undefined;
}) {
  const t = useTranslations('loyalty.customer.community');
  const format = useFormatter();
  const tone: Tone = item.type === 'earn' ? 'mint' : item.type === 'redeem' ? 'violet' : 'neutral';
  const points = format.number(item.points, { signDisplay: 'exceptZero' });
  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <p className={styles.rowTitle}>
          <span className={styles.badge} data-tone={tone}>
            {t(`activity.type.${item.type}`)}
          </span>{' '}
          <span>{t(`activity.source.${item.sourceType}`)}</span>
        </p>
        <p className={styles.rowMeta}>
          {business && <span>{t('activity.at', { name: business })} · </span>}
          {item.reversalOf && <span>{t('activity.reversalNote')} · </span>}
          <time dateTime={item.createdAt}>
            {format.dateTime(new Date(item.createdAt), 'short')}
          </time>
        </p>
      </div>
      <p
        className={styles.rowPoints}
        data-tone={tone}
        aria-label={t('activity.pointsLabel', { points })}
      >
        <bdi>{points}</bdi>
      </p>
    </li>
  );
}
