import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { resolveSupportedLocale, type QrResolveDto } from '@echo-grid-feedback/shared-types';
import { publicApiFetch } from '@/lib/public-api-client';
import { ApiError } from '@/lib/api-client';
import { hasCustomerSession } from '@/lib/customer-session';
import { loadMessages } from '@/i18n/load-messages';
import { CheckinPanel } from './checkin-panel';

interface LoyaltyCheckinPageProps {
  params: Promise<{ token: string }>;
}

/**
 * The loyalty counterpart to app/feedback/[token]/page.tsx -- same QR
 * token, same anonymous server-side resolve-or-404 pattern, different
 * destination action (check in for points instead of leaving feedback).
 * Whether the visitor already has a customer session is resolved here
 * (server-side, from the httpOnly cookie) and handed down as a plain
 * boolean, so the client component never needs to guess or flash between
 * states.
 */
export default async function LoyaltyCheckinPage({ params }: LoyaltyCheckinPageProps) {
  const { token } = await params;

  let qr: QrResolveDto;
  try {
    qr = await publicApiFetch<QrResolveDto>(`/qr/${token}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const signedIn = await hasCustomerSession();

  // Same reasoning as feedback/[token]/page.tsx: fully anonymous, so qr's
  // own defaultLocale (i18n & Multi-Currency Block 2) is the only signal
  // available for which business's locale this page should render in.
  const locale = resolveSupportedLocale(qr.defaultLocale);
  const messages = await loadMessages(locale);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <CheckinPanel
        token={token}
        branchName={qr.branchName}
        businessName={qr.businessName}
        signedIn={signedIn}
      />
    </NextIntlClientProvider>
  );
}
