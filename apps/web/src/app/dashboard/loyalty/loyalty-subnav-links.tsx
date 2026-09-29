'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface LoyaltyNavItem { href: string; label: string }

export function LoyaltySubnavLinks({ items }: { items: LoyaltyNavItem[] }) {
  const pathname = usePathname();
  const activeHref = items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return items.map((item) => {
    const active = item.href === activeHref;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={active ? 'rounded-md bg-brand-50 px-2 py-1.5 text-sm font-medium text-brand-700' : 'rounded-md px-2 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 hover:text-brand-700'}
      >
        {item.label}
      </Link>
    );
  });
}
