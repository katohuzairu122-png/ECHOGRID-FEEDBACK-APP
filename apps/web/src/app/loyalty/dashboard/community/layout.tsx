import { getNetworkFeedEnabled } from '@/lib/network-status';
import { CommunitySectionNav } from './community-section-nav';
import styles from './community-sections.module.css';

/**
 * One Community entry in the customer navigation. The section control (Points & Membership, Feed) is rendered only
 * while the Network Feed flag is on; with it off Community is exactly the Points & Membership page. Session gate:
 * parent layout.
 */
export default async function CommunityLayout({ children }: { children: React.ReactNode }) {
  const showFeed = await getNetworkFeedEnabled();
  return (
    <div className={styles.frame}>
      <CommunitySectionNav showFeed={showFeed} />
      {children}
    </div>
  );
}
