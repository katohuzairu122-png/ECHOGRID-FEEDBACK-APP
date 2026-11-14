'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface CashierTab {
  href: string;
  label: string;
}

/** Mobile-first bottom navigation: three large touch targets, the current one marked for assistive tech. */
export function CashierTabs({ tabs, label }: { tabs: CashierTab[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-2xl">
        {tabs.map((tab) => {
          const active = tab.href === '/cashier' ? pathname === '/cashier' : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'flex min-h-14 items-center justify-center px-2 text-sm font-semibold text-brand-700'
                    : 'flex min-h-14 items-center justify-center px-2 text-sm text-neutral-600'
                }
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
