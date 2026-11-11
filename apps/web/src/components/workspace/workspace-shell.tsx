import type { ReactNode } from 'react';
import { AppFooter } from '@/components/brand';
import styles from './workspace.module.css';
import { WorkspaceThemeRoot, type WorkspaceTheme } from './workspace-theme';

/** Presentation-only boundary. Authorization remains in each existing layout/API. */
export function WorkspaceShell({
  navigation,
  context,
  children,
  skipLabel,
  footer = <AppFooter />,
  theme,
}: {
  navigation: ReactNode;
  context?: ReactNode;
  children: ReactNode;
  skipLabel: string;
  footer?: ReactNode;
  theme?: WorkspaceTheme;
}) {
  return (
    <WorkspaceThemeRoot {...(theme ? { theme } : {})} className={styles.workspace}>
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
    </WorkspaceThemeRoot>
  );
}
