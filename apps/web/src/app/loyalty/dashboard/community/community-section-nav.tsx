'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import styles from './community-sections.module.css';

export const COMMUNITY_BASE_PATH = '/loyalty/dashboard/community';
export const COMMUNITY_FEED_PATH = `${COMMUNITY_BASE_PATH}/feed`;

/**
 * Section control INSIDE the single top-level Community entry: "Points & Membership" and "Feed". Real links to
 * real routes, so deep links, history and keyboard navigation work without client state; the current section
 * is exposed with aria-current. Presentation only: authorization stays in the layout and the API.
 */
export function CommunitySectionNav({ showFeed }: { showFeed: boolean }) {
  const t = useTranslations('loyalty.customer.community.sections');
  const pathname = usePathname();
  const onFeed = pathname === COMMUNITY_FEED_PATH || pathname.startsWith(`${COMMUNITY_FEED_PATH}/`);
  // The Feed section exists only while the Network flag is on; otherwise Community is just Points & Membership and
  // no section control is rendered at all.
  if (!showFeed) return null;
  const sections = [
    { href: COMMUNITY_BASE_PATH, label: t('points'), current: !onFeed },
    { href: COMMUNITY_FEED_PATH, label: t('feed'), current: onFeed },
  ];
  return (
    <nav className={styles.sectionNav} aria-label={t('label')}>
      <ul>
        {sections.map((section) => (
          <li key={section.href}>
            <Link
              href={section.href}
              className={styles.sectionLink}
              aria-current={section.current ? 'page' : undefined}
            >
              {section.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
