import type { ReactNode } from 'react';
import { AppFooter } from '@/components/brand';
import styles from './workspace.module.css';

/** Presentation-only boundary. Authorization remains in each existing layout/API. */
export function WorkspaceShell({
  navigation,
  context,
  children,
  skipLabel,
  footer = <AppFooter />,
}: {
  navigation: ReactNode;
  context?: ReactNode;
  children: ReactNode;
  skipLabel: string;
  footer?: ReactNode;
}) {
  return (
    <div className={styles.workspace}>
      <a href="#workspace-content" className={styles.skipLink}>
        {skipLabel}
      </a>
      {navigation}
      <div className={styles.body}>
        {context && <header className={styles.context}>{context}</header>}
        <main id="workspace-content" tabIndex={-1} className={styles.content}>
          {children}
        </main>
        {footer}
      </div>
    </div>
  );
}
