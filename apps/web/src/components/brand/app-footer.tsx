import { cn } from '@/lib/utils';

/**
 * Bottom-of-shell attribution for Echo Grid's own authenticated surfaces
 * (staff dashboard, platform console, customer loyalty dashboard) -- just
 * the INFINICUS parent-company line, no repeated logo mark since the nav
 * above already carries one on every page in these shells.
 */
export function AppFooter({ className }: { className?: string | undefined }) {
  return (
    <footer className={cn('py-6 text-center text-xs text-neutral-400', className)}>
      An <span className="font-medium text-neutral-500">INFINICUS</span> Company
    </footer>
  );
}
