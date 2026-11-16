import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import type { CommunityFeedResult } from '@/lib/community-feed-types';
import styles from '../community-sections.module.css';

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
}: {
  result: CommunityFeedResult;
  /** The cursor this page was loaded with (null on the first page); only used to offer a way back to the start. */
  cursor?: string | null;
}) {
  const t = useTranslations('loyalty.customer.community');
  const format = useFormatter();

  return (
    <section className={styles.feed} aria-labelledby="community-feed-title">
      <header>
        <p className="sr-only">{t('feed.eyebrow')}</p>
        <h1 id="community-feed-title">{t('feed.title')}</h1>
        <p>{t('feed.description')}</p>
      </header>

      {result.status !== 'ready' ? (
        <div className={styles.state} role="status" data-state={result.status}>
          <p>{result.status === 'forbidden' ? t('feed.forbidden') : t('feed.error')}</p>
          {result.status === 'unavailable' && (
            <Link className={styles.action} href={cursor ? `${FEED_PATH}?cursor=${cursor}` : FEED_PATH}>
              {t('feed.retry')}
            </Link>
          )}
        </div>
      ) : result.data.items.length === 0 ? (
        <div className={styles.state} data-state="empty">
          <h2>{t('feed.empty.title')}</h2>
          <p>{t('feed.empty.body')}</p>
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
                    {href && (
                      <a className={styles.cardLink} href={href} rel="noopener noreferrer nofollow" target="_blank">
                        {t('feed.openLink')}
                      </a>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
          {result.data.nextCursor && (
            <Link className={styles.action} href={`${FEED_PATH}?cursor=${encodeURIComponent(result.data.nextCursor)}`}>
              {t('feed.loadMore')}
            </Link>
          )}
        </>
      )}
    </section>
  );
}
