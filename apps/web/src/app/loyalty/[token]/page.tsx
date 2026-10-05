import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { resolveSupportedLocale, type QrResolveDto, type BranchProgramDto } from '@echo-grid-feedback/shared-types';
import { BranchLanding } from '../branch-landing';
import { publicApiFetch } from '@/lib/public-api-client';
import { ApiError } from '@/lib/api-client';
import { hasCustomerSession } from '@/lib/customer-session';
import { loadMessages } from '@/i18n/load-messages';
import { formats } from '@/i18n/formats';
import { CheckinPanel } from './checkin-panel';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface LoyaltyCheckinPageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ feedback?: string; autocheckin?: string }>;
}

/**
 * The loyalty counterpart to app/feedback/[token]/page.tsx -- same QR
 * token, same anonymous server-side resolve-or-404 pattern, different
 * destination action (check in for points instead of leaving feedback).
 * This route is always dynamic because its signed-in state comes from the
 * customer cookie written immediately before the OTP redirect.
 */
export default async function LoyaltyCheckinPage({ params, searchParams }: LoyaltyCheckinPageProps) {
  const [{ token }, query] = await Promise.all([params, searchParams]);

  let qr: QrResolveDto;
  try {
    qr = await publicApiFetch<QrResolveDto>(`/qr/${token}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const signedIn = await hasCustomerSession();

  const locale = resolveSupportedLocale(qr.defaultLocale);
  const messages = await loadMessages(locale);
  const program = await publicApiFetch<BranchProgramDto | null>(`/branch-loyalty/public/qr/${token}`);

  return (
    <NextIntlClientProvider locale={locale} messages={messages} formats={formats}>
      {program ? <BranchLanding token={token} qr={qr} program={program} /> : <CheckinPanel
        token={token}
        branchName={qr.branchName}
        businessName={qr.businessName}
        signedIn={signedIn}
        feedbackReceived={query.feedback === 'received'}
        autoCheckin={query.autocheckin === '1'}
      />}
    </NextIntlClientProvider>
  );
}
