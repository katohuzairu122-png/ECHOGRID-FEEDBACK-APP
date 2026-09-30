import Link from 'next/link';
import { cn } from '@/lib/utils';

export function AppFooter({ className }: { className?: string | undefined }) {
  return (
    <footer className={cn('space-y-2 py-6 text-center text-xs text-neutral-400', className)}>
      <p>
        An <span className="font-medium text-neutral-500">INFINICUS</span> Company
      </p>
      <nav aria-label="Support and legal" className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        <Link href="/support" className="hover:text-neutral-600">Support</Link>
        <Link href="/privacy" className="hover:text-neutral-600">Privacy</Link>
        <Link href="/terms" className="hover:text-neutral-600">Terms</Link>
        <Link href="/refunds" className="hover:text-neutral-600">Refunds</Link>
        <Link href="/cookies" className="hover:text-neutral-600">Cookies</Link>
      </nav>
    </footer>
  );
}
