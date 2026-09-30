import Link from 'next/link';
import { Logo } from '@/components/brand';

export const LEGAL_CONTACT_EMAIL = 'support@echo-grid.uk';
export const LEGAL_EFFECTIVE_DATE = '30 September 2026';

export function LegalPage({
  title,
  children,
}: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-12 text-neutral-800">
      <article className="mx-auto max-w-3xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-10">
        <Link href="/" aria-label="Echo Grid home" className="inline-flex">
          <Logo variant="full" iconSize={36} />
        </Link>
        <h1 className="mt-8 text-3xl font-bold text-neutral-950">{title}</h1>
        <p className="mt-2 text-sm text-neutral-500">Effective {LEGAL_EFFECTIVE_DATE}</p>
        <div className="mt-8 space-y-7 leading-7 [&_a]:text-brand-700 [&_a]:underline [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-neutral-950 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
          {children}
        </div>
        <nav aria-label="Legal and support" className="mt-10 flex flex-wrap gap-x-5 gap-y-2 border-t border-neutral-200 pt-6 text-sm">
          <Link href="/support">Support</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/refunds">Refunds</Link>
          <Link href="/cookies">Cookies</Link>
        </nav>
      </article>
    </main>
  );
}
