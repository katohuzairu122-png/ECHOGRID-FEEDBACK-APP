import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { resolveSupportedLocale, type QrResolveDto } from '@echo-grid-feedback/shared-types';
import { publicApiFetch } from '@/lib/public-api-client';
import { ApiError } from '@/lib/api-client';
import { loadMessages } from '@/i18n/load-messages';
import { FeedbackForm } from './feedback-form';

interface FeedbackLandingPageProps {
  params: Promise<{ token: string }>;
}

/**
 * The actual "front door" of QR Engagement -- where a customer lands after
 * scanning a branch's QR code. Resolves the token server-side (Server
 * Component, not a client-side fetch) so an invalid/revoked token can
 * short-circuit to notFound() before any client JS loads, and so the
 * initial branch/business name renders with no loading spinner. The
 * interactive form itself (rating, comment, submit) is a separate Client
 * Component -- see feedback-form.tsx.
 */
export default async function FeedbackLandingPage({ params }: FeedbackLandingPageProps) {
  const { token } = await params;

  let qr: QrResolveDto;
  try {
    qr = await publicApiFetch<QrResolveDto>(`/qr/${token}`);
  } catch (err) {
    // A revoked/unknown token resolves to the same 404 the API deliberately
    // returns for both (enumeration resistance) -- rendered here via the
    // custom not-found.tsx for this route segment. Anything else (a genuine
    // 5xx) is a real unexpected failure and should NOT be silently treated
    // as "this code doesn't exist" -- let it bubble to Next's default error
    // boundary instead.
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  // Fully anonymous: no session, no other route param to resolve a
  // business's locale from -- qr already carries defaultLocale (i18n &
  // Multi-Currency Block 2), so this overrides the root layout's
  // staff-resolved default with the scanned branch's own business locale.
  const locale = resolveSupportedLocale(qr.defaultLocale);
  const messages = await loadMessages(locale);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <FeedbackForm token={token} branchName={qr.branchName} businessName={qr.businessName} />
    </NextIntlClientProvider>
  );
}
