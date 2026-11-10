import type { ReactNode } from 'react';
import Link from 'next/link';
import { LandingIcon, type LandingIconName } from '@/components/landing/landing-icon';
import styles from './workspace.module.css';

export function MetricCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint: string;
  icon: LandingIconName;
}) {
  return (
    <article className={styles.metric} aria-label={label}>
      <span className={styles.metricIcon}>
        <LandingIcon name={icon} width={23} height={23} />
      </span>
      <h2 className={styles.metricLabel}>{label}</h2>
      <strong className={styles.metricValue}>{value}</strong>
      <p className={styles.metricHint}>{hint}</p>
    </article>
  );
}
export function OverviewPanel({
  title,
  href,
  linkLabel,
  children,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.panel}>
      <header className={styles.panelHeading}>
        <h2>{title}</h2>
        {href && (
          <Link href={href} className="text-xs font-medium">
            {linkLabel}
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}
export function WorkspaceState({ children }: { children: ReactNode }) {
  return (
    <p className={styles.state} role="status">
      {children}
    </p>
  );
}
