import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import type { CommunityFeedResult } from '@/lib/community-feed-types';
import styles from '../community-sections.module.css';
import { FeedRefreshButton } from './feed-refresh-button';
import { FollowButton } from './follow-button';
import { PostLink } from './post-link';

const FEED_PATH = '/loyalty/dashboard/community/feed';

/** Only an https link is ever rendered as a link (re-validated at render, NETWORK-00 section 8). */
function safeHttpsHref(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function CommunityFeedView({
  result,
  cursor = null,
  filter = 'all',
  followed = null,
}: {
  result: CommunityFeedResult;
  /** BCOMM-04: the current view. `following` shows only businesses the customer chose to follow. */
  filter?: 'all' | 'following';
  /** The customer's own followed business handles, or null when unknown (no follow control is then shown). */
  followed?: Set<string> | null;
  /** The cursor this page was loaded with (null on the first page); only used to offer a way back to the start. */
  cursor?: string | null;
}) {
  const t = useTranslations('loyalty.customer.community');
  const format = useFormatter();

  // Fixed account route and Feed-only return path. Never accept a client-supplied destination or verification flag.
  const returnPath = cursor && /^[A-Za-z0-9_-]{1,200}$/.test(cursor)
    ? `${FEED_PATH}?cursor=${encodeURIComponent(cursor)}` : FEED_PATH;
  const nextHref = (cursorValue: string) => `${FEED_PATH}?${filter === 'following' ? 'filter=following&' : ''}cursor=${encodeURIComponent(cursorValue)}`;
  const verificationHref = `/loyalty/dashboard/phone?next=${encodeURIComponent(returnPath)}`;

  return (
    <section className={styles.feed} aria-labelledby="community-feed-title">
      <header>
        <p className="sr-only">{t('feed.eyebrow')}</p>
        <h1 id="community-feed-title">{t('feed.title')}</h1>
        <p>{t('feed.description')}</p>
      </header>

      {result.status === 'ready' && (
        <nav aria-label={t('feed.filterLabel')} className={styles.feedActions}>
          <Link className={styles.action} href={FEED_PATH} aria-current={filter === 'all' ? 'page' : undefined}>{t('feed.filterAll')}</Link>
          <Link className={styles.action} href={`${FEED_PATH}?filter=following`} aria-current={filter === 'following' ? 'page' : undefined}>{t('feed.filterFollowing')}</Link>
        </nav>
      )}

      {(result.status === 'ready' || result.status === 'unavailable') && (
        <div className={styles.feedActions}>
          <FeedRefreshButton retry={result.status === 'unavailable'} />
          {cursor && (
            <Link className={styles.action} href={FEED_PATH}>
              {t('feed.latest')}
            </Link>
          )}
        </div>
      )}

      {result.status !== 'ready' ? (
        <div className={styles.state} role="status" data-state={result.status}>
          <p>{result.status === 'verification_required'
            ? t('feed.verificationRequired')
            : result.status === 'forbidden' ? t('feed.forbidden') : t('feed.error')}</p>
          {result.status === 'verification_required' && (
            <>
              <Link className={styles.action} href={verificationHref}>{t('feed.verifyPhone')}</Link>
              <Link className={styles.action} href="/loyalty/dashboard/community">{t('sections.points')}</Link>
            </>
          )}
        </div>
      ) : result.data.items.length === 0 ? (
        <div className={styles.state} data-state="empty">
          <h2>{filter === 'following' ? t('feed.followingEmpty.title') : t('feed.empty.title')}</h2>
          <p>{filter === 'following' ? t('feed.followingEmpty.body') : t('feed.empty.body')}</p>
        </div>
      ) : (
        <>
          <ul className={styles.feedList} aria-label={t('feed.listLabel')}>
            {result.data.items.map((item) => {
              const href = safeHttpsHref(item.linkUrl);
              return (
                <li key={item.handle}>
                  <article className={styles.card} lang={item.contentLocale}>
                    <div className={styles.cardMeta}>
                      <span className={styles.badge} data-class={item.contentClass}>
                        {item.contentClass === 'official'
                          ? t('feed.official')
                          : (item.businessName ?? t('feed.business'))}
                      </span>
                      <time dateTime={item.publishedAt}>
                        {t('feed.publishedOn', {
                          date: format.dateTime(new Date(item.publishedAt), 'short'),
                        })}
                      </time>
                    </div>
                    <p className={styles.cardBody}>{item.body}</p>
                    {item.contentClass === 'business_post' && item.businessHandle && followed ? (
                      <FollowButton handle={item.businessHandle} following={followed.has(item.businessHandle)} name={item.businessName ?? t('feed.business')} />
                    ) : null}
                    {href && <PostLink className={styles.cardLink} href={href} handle={item.handle} businessPost={item.contentClass === 'business_post'} />}
                  </article>
                </li>
              );
            })}
          </ul>
          {result.data.nextCursor && (
            <Link
              className={styles.action}
              href={nextHref(result.data.nextCursor)}
            >
              {t('feed.loadMore')}
            </Link>
          )}
        </>
      )}
    </section>
  );
}
