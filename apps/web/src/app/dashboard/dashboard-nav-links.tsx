'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface DashboardNavItem {
  href: string;
  label: string;
}

export function isDashboardNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** When navigation entries are nested, only the most specific match is
 * current (for example Team, not both Settings and Team). */
export function getActiveDashboardNavHref(pathname: string, items: DashboardNavItem[]): string | undefined {
  return items
    .filter((item) => isDashboardNavItemActive(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function DashboardNavLinks({ items }: { items: DashboardNavItem[] }) {
  const pathname = usePathname();
  const activeHref = getActiveDashboardNavHref(pathname, items);

  return (
    <>
      {items.map((item) => {
        const active = activeHref === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'rounded-md bg-brand-50 px-2 py-1.5 text-sm font-medium text-brand-700'
                : 'rounded-md px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900'
            }
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}


