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

export function DashboardNavLinks({ items }: { items: DashboardNavItem[] }) {
  const pathname = usePathname();

  return (
    <>
      {items.map((item) => {
        const active = isDashboardNavItemActive(pathname, item.href);
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

