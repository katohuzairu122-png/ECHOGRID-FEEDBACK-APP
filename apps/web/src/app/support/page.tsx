import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/brand';
import { buttonVariants } from '@/components/ui';

const SUPPORT_EMAIL = 'support@echo-grid.uk';

export const metadata: Metadata = { title: 'Support' };

export default function SupportPage() {
  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-12 text-neutral-800">
      <section className="mx-auto max-w-2xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-10">
        <Link href="/" aria-label="Echo Grid home" className="inline-flex">
          <Logo variant="full" iconSize={36} />
        </Link>
        <h1 className="mt-8 text-3xl font-bold text-neutral-950">Echo Grid Support</h1>
        <p className="mt-3 leading-7 text-neutral-600">
          Contact us for account access, feedback collection, billing, privacy, or technical help.
        </p>
        <div className="mt-8 rounded-xl bg-brand-50 p-5">
          <h2 className="font-semibold text-neutral-950">Email support</h2>
          <p className="mt-1 text-sm text-neutral-600">Describe the issue and include your business name. Never send passwords or complete payment-card details.</p>
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=Echo%20Grid%20support%20request`}
            className={buttonVariants({ className: 'mt-5' })}
          >
            Email {SUPPORT_EMAIL}
          </a>
        </div>
        <nav aria-label="Support links" className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link href="/privacy" className="text-brand-700 underline">Privacy</Link>
          <Link href="/terms" className="text-brand-700 underline">Terms</Link>
          <Link href="/refunds" className="text-brand-700 underline">Refunds</Link>
        </nav>
      </section>
    </main>
  );
}
