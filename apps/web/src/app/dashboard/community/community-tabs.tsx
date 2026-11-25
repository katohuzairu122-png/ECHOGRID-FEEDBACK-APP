'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface CommunityTab {
  href: string;
  label: string;
}

/** Internal sections of the one Community hub. Not top-level navigation: a quiet tab row inside the page. The current section is marked for assistive technology. */
export function CommunityTabs({ items, label }: { items: CommunityTab[]; label: string }) {
  const pathname = usePathname();
  const active = items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2 border-b border-neutral-200 pb-2">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={active === item.href ? 'page' : undefined}
          className={
            active === item.href
              ? 'min-h-11 rounded-md bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-700'
              : 'min-h-11 rounded-md px-3 py-2 text-sm text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900'
          }
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
