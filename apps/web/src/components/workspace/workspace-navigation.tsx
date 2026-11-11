'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Workspace navigation. Desktop: a fixed sidebar with every destination and the utilities (logout, install).
 * Small screens: a bottom bar with the first `primaryCount` destinations plus "More"; every remaining
 * destination AND the utilities (logout included) live in the More sheet. The sheet is a modal dialog: focus
 * moves into it, Tab is trapped, Escape/backdrop/close/navigation dismiss it and focus returns to the More
 * button. The utilities are pinned below a scrolling list, so logout stays on screen on short displays.
 * Presentation only: authorization remains in each layout and the API.
 */
export function WorkspaceNavigation({
  items,
  home,
  label,
  menuLabel,
  moreLabel,
  closeLabel = 'Close',
  primaryCount = 4,
  utilities,
}: {
  items: WorkspaceNavItem[];
  home: string;
  label: string;
  menuLabel: string;
  moreLabel?: string;
  closeLabel?: string;
  primaryCount?: number;
  utilities: ReactNode;
}) {
  const pathname = usePathname();
  const active = activeWorkspaceHref(pathname, items);
  const more = moreLabel ?? menuLabel;
  const primary = items.slice(0, primaryCount);
  const overflow = items.slice(primaryCount);
  const moreActive = overflow.some((item) => item.href === active);

  const [open, setOpen] = useState(false);
  const sheetId = useId();
  const moreButton = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) moreButton.current?.focus();
  }, []);

  // Navigating (or the route changing for any reason) dismisses the sheet.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = sheet.current?.querySelector<HTMLElement>('nav a[href], ' + FOCUSABLE);
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !sheet.current) return;
      const focusables = Array.from(sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (!firstEl || !lastEl) return;
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    // The sheet only exists below the desktop breakpoint: close it if the viewport grows past it.
    const query =
      typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1024px)') : null;
    const onResize = () => {
      if (query?.matches) setOpen(false);
    };
    query?.addEventListener?.('change', onResize);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
      query?.removeEventListener?.('change', onResize);
    };
  }, [open, close]);

  const links = (subset: WorkspaceNavItem[], onNavigate?: () => void) =>
    subset.map((item) => (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active === item.href ? 'page' : undefined}
        {...(onNavigate ? { onClick: onNavigate } : {})}
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
        <Link href={home} aria-label={label}>
          <Logo variant="dark" iconSize={30} />
        </Link>
      </header>
      <nav className={styles.bottomNav} aria-label={label}>
        {links(primary)}
        <button
          ref={moreButton}
          type="button"
          className={styles.moreButton}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? sheetId : undefined}
          data-active={moreActive ? 'true' : undefined}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <LandingIcon name="more" width={21} height={21} />
          <span>{more}</span>
        </button>
      </nav>
      {open && (
        <div className={styles.sheetLayer}>
          <button
            type="button"
            className={styles.sheetBackdrop}
            aria-label={closeLabel}
            tabIndex={-1}
            onClick={() => close()}
          />
          <div
            id={sheetId}
            ref={sheet}
            role="dialog"
            aria-modal="true"
            aria-label={more}
            className={styles.sheet}
          >
            <div className={styles.sheetHeader}>
              <h2>{more}</h2>
              <button
                type="button"
                className={styles.sheetClose}
                aria-label={closeLabel}
                onClick={() => close()}
              >
                <LandingIcon name="close" width={20} height={20} />
              </button>
            </div>
            <nav aria-label={more} className={styles.sheetNav}>
              {links(overflow, () => setOpen(false))}
            </nav>
            <div className={styles.sheetUtilities}>{utilities}</div>
          </div>
        </div>
      )}
    </>
  );
}
