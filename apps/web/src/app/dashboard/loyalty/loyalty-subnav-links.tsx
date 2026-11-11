'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface LoyaltyNavItem { href: string; label: string }

/** The parent is a scrollable, styled nav; the current page remains the longest matching route. */
export function LoyaltySubnavLinks({ items }: { items: LoyaltyNavItem[] }) {
  const pathname = usePathname();
  const activeHref = items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return items.map((item) => (
    <Link
      key={item.href}
      href={item.href}
      aria-current={item.href === activeHref ? 'page' : undefined}
    >
      {item.label}
    </Link>
  ));
}
