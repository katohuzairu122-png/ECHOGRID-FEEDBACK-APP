import { CommunitySectionNav } from './community-section-nav';
import styles from './community-sections.module.css';

/** One Community entry in the customer navigation; its two sections share this frame. Session gate: parent layout. */
export default function CommunityLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.frame}>
      <CommunitySectionNav />
      {children}
    </div>
  );
}
