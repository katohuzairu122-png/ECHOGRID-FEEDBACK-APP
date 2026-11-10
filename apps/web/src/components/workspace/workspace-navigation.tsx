'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/brand';
import { LandingIcon, type LandingIconName } from '@/components/landing/landing-icon';
import styles from './workspace.module.css';

export interface WorkspaceNavItem {
  href: string;
  label: string;
  icon: LandingIconName;
}

export function activeWorkspaceHref(pathname: string, items: WorkspaceNavItem[]) {
  return items
    .filter((item) => pathname === item.href || pathname.startsWith(item.href + '/'))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function WorkspaceNavigation({
  items,
  home,
  label,
  menuLabel,
  utilities,
}: {
  items: WorkspaceNavItem[];
  home: string;
  label: string;
  menuLabel: string;
  utilities: ReactNode;
}) {
  const pathname = usePathname();
  const active = activeWorkspaceHref(pathname, items);
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (menu.current) menu.current.open = false;
  };
  useEffect(close, [pathname]);
  const links = (subset: WorkspaceNavItem[]) =>
    subset.map((item) => (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active === item.href ? 'page' : undefined}
        onClick={close}
      >
        <LandingIcon name={item.icon} width={21} height={21} />
        <span>{item.label}</span>
      </Link>
    ));
  return (
    <>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} href={home}>
          <Logo variant="dark" iconSize={35} />
        </Link>
        <p className={styles.workspaceLabel}>{label}</p>
        <nav aria-label={menuLabel}>{links(items)}</nav>
        <div className={styles.utilities}>{utilities}</div>
      </aside>
      <header className={styles.mobileHeader}>
        <Link href={home}>
          <Logo variant="horizontal" iconSize={28} />
        </Link>
        <details
          ref={menu}
          className={styles.mobileMenu}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              close();
              menu.current?.querySelector('summary')?.focus();
            }
          }}
        >
          <summary aria-label={menuLabel} tabIndex={0}>
            <LandingIcon name="settings" width={22} height={22} />
            <span>{menuLabel}</span>
          </summary>
          <div className={styles.menuPanel}>
            <nav aria-label={menuLabel}>{links(items)}</nav>
            <div className={styles.mobileUtilities}>{utilities}</div>
          </div>
        </details>
      </header>
      <nav className={styles.bottomNav} aria-label={label}>
        {links(items.slice(0, 4))}
      </nav>
    </>
  );
}
