import { NextIntlClientProvider } from 'next-intl';
import { resolveSupportedLocale, type BusinessPublicDto } from '@echo-grid-feedback/shared-types';
import { publicApiFetch } from '@/lib/public-api-client';
import { loadMessages } from '@/i18n/load-messages';
import { AppFooter } from '@/components/brand';

interface LoyaltyBusinessLayoutProps {
  children: React.ReactNode;
  params: Promise<{ businessId: string }>;
}

/**
 * Overrides the root layout's locale with THIS business's own
 * defaultLocale for the entire customer-facing /loyalty/dashboard/
 * [businessId] subtree (i18n & Multi-Currency Block 2) -- a customer at a
 * French business should see French regardless of what the request-level
 * default in i18n/request.ts happened to resolve to (that default is
 * staff-session-based and has no reason to match the business a *customer*
 * is viewing). A nested NextIntlClientProvider is next-intl's documented
 * mechanism for exactly this "part of the tree needs a different locale"
 * case.
 *
 * Fetches /businesses/:id/public itself rather than relying on
 * page.tsx's own fetch of the same endpoint -- Next.js's fetch request
 * memoization dedupes identical GET calls within one render pass, so this
 * costs no extra round trip in practice. Fails open to
 * resolveSupportedLocale's DEFAULT_LOCALE fallback: never let a locale
 * lookup break a customer's own rewards page.
 */
export default async function LoyaltyBusinessLayout({
  children,
  params,
}: LoyaltyBusinessLayoutProps) {
  const { businessId } = await params;

  let business: BusinessPublicDto | null = null;
  try {
    business = await publicApiFetch<BusinessPublicDto>(`/businesses/${businessId}/public`);
  } catch {
    business = null;
  }

  const locale = resolveSupportedLocale(business?.defaultLocale);
  const messages = await loadMessages(locale);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="flex min-h-screen flex-col bg-neutral-50">
        <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">{children}</main>
        <AppFooter />
      </div>
    </NextIntlClientProvider>
  );
}
