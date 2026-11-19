import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { resolveSupportedLocale, type AssistedInvitePreviewDto } from '@echo-grid-feedback/shared-types';
import { ApiError } from '@/lib/api-client';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { hasCustomerSession } from '@/lib/customer-session';
import { INVITE_TOKEN_PATTERN, previewAssistedInvite } from '@/lib/loyalty-invite';
import { loadMessages } from '@/i18n/load-messages';
import { getLocaleOverride } from '@/lib/customer-language';
import { LanguageSelector } from '@/components/language-selector';
import { formats } from '@/i18n/formats';
import { InvitePanel } from './invite-panel';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * CASHIER-AUTH-02D: where a customer lands after scanning a cashier's one-time onboarding code. Always dynamic: the signed-in state and the
 * invitation's state come from the customer cookie and the API. A signed-out visitor sees only a sign-in prompt (nothing about the
 * invitation is revealed before the customer authenticates); the customer then consents explicitly, as everywhere else a membership is created.
 */
export default async function LoyaltyInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!INVITE_TOKEN_PATTERN.test(token)) notFound();

  const signedIn = await hasCustomerSession();
  let preview: AssistedInvitePreviewDto | null = null;
  let invalid = false;
  if (signedIn) {
    try {
      preview = await previewAssistedInvite(token);
    } catch (err) {
      rethrowControlFlow(err);
      if (err instanceof ApiError && (err.status === 400 || err.status === 409)) invalid = true;
      else throw err;
    }
  }

  const locale = resolveSupportedLocale(await getLocaleOverride());
  const messages = await loadMessages(locale);
  return (
    <NextIntlClientProvider locale={locale} messages={messages} formats={formats}>
      <div className="mx-auto flex w-full max-w-2xl justify-end px-4 pt-4">
        <LanguageSelector className="w-40" />
      </div>
      <InvitePanel token={token} signedIn={signedIn} preview={preview} invalid={invalid} />
    </NextIntlClientProvider>
  );
}
