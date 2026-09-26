'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { logoutAction } from '@/lib/actions/auth';

interface PlatformMobileNavItem {
  href: string;
  label: string;
}

export function PlatformMobileNav({
  items,
  menuLabel,
  logoutLabel,
}: {
  items: PlatformMobileNavItem[];
  menuLabel: string;
  logoutLabel: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  const closeMenu = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  useEffect(closeMenu, [pathname]);

  const prefetchDestinations = () => {
    if (!detailsRef.current?.open) return;
    for (const item of items) router.prefetch(item.href);
  };

  return (
    <details ref={detailsRef} onToggle={prefetchDestinations} className="group relative lg:hidden">
      <summary className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-md border border-neutral-200 text-neutral-700 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 [&::-webkit-details-marker]:hidden">
        <span className="sr-only">{menuLabel}</span>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5 group-open:hidden">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="hidden h-5 w-5 group-open:block">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </summary>
      <div className="absolute end-0 z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-200 bg-white p-2 shadow-lg">
        <nav className="grid" aria-label={menuLabel}>
          {items.map((item) => (
            <Link key={item.href} href={item.href} onClick={closeMenu} className="rounded-md px-3 py-2.5 text-sm text-neutral-700 hover:bg-neutral-50 hover:text-neutral-950">
              {item.label}
            </Link>
          ))}
        </nav>
        <form action={logoutAction} className="mt-1 border-t border-neutral-100 pt-1">
          <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
            {logoutLabel}
          </Button>
        </form>
      </div>
    </details>
  );
}
