'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isCameraPath } from '@/lib/camera-routes';

interface LoyaltyNavItem { href: string; label: string }

/** The parent is a scrollable, styled nav; the current page remains the longest matching route. */
export function LoyaltySubnavLinks({ items }: { items: LoyaltyNavItem[] }) {
  const pathname = usePathname();
  const activeHref = items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  // A camera page (the customer-QR scanner) must be entered with a full page load: its Permissions-Policy is fixed when
  // the document loads (see lib/camera-routes.ts), so a client-side transition would leave the camera denied.
  return items.map((item) => {
    const current = item.href === activeHref ? ('page' as const) : undefined;
    return isCameraPath(item.href) ? (
      <a key={item.href} href={item.href} aria-current={current}>
        {item.label}
      </a>
    ) : (
      <Link key={item.href} href={item.href} aria-current={current}>
        {item.label}
      </Link>
    );
  });
}
