import { getTranslations } from 'next-intl/server';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui';

/**
 * Custom 404 for this route segment only (Next.js renders the nearest
 * not-found.tsx up the tree) -- a generic framework 404 page here would
 * look broken/untrustworthy to a real customer who just scanned a
 * business's QR code, which is worse than the small cost of a dedicated
 * file for this one message.
 *
 * i18n & Multi-Currency Block 5: unlike page.tsx, this file has no QR
 * token to resolve a business's locale from (that's the whole point of a
 * 404 -- the token never resolved to one), so it can only ever render in
 * the root layout's default locale, not a business-specific one. Accepted
 * limitation, not a bug -- there is no locale signal available here.
 */
export default async function FeedbackNotFound() {
  const t = await getTranslations('feedback.notFound');

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-8">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
