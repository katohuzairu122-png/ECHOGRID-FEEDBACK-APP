import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui';
import { Logo } from '@/components/brand';
import { ResetPasswordForm } from './reset-password-form';

interface ResetPasswordPageProps {
  /** `token` comes from the link in the reset email
   * (auth/password-reset.ts's buildResetLink). Optional in the type because
   * a user can always reach this URL without one -- a truncated email link,
   * a bookmark, a copy-paste that dropped the query string. */
  searchParams: Promise<{ token?: string }>;
}

/**
 * Step 2 of account recovery.
 *
 * A Server Component that reads the token and hands it to a client form,
 * rather than a client component calling useSearchParams() -- the same
 * split loyalty/[token]/page.tsx already uses, and it avoids the Suspense
 * boundary that reading search params client-side would otherwise require.
 *
 * The token is NOT validated here. Checking it up front would need a second
 * endpoint that answers "is this token real?", which is exactly the oracle
 * POST /auth/password-reset/confirm is careful not to be -- and it would
 * still race, since a link can expire between page load and submit. The
 * form submits, the API decides, and one INVALID_RESET_TOKEN message covers
 * every failure.
 */
export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const { token } = await searchParams;
  const t = await getTranslations('auth.resetPassword');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-8">
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{token ? t('description') : t('missingTokenDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {token ? (
            <ResetPasswordForm token={token} />
          ) : (
            // No form at all without a token -- submitting one could only
            // ever fail, and an empty field the user cannot fill in is worse
            // than a clear route back to requesting a fresh link.
            <p role="status" className="text-sm text-neutral-600">
              {t('missingTokenBody')}
            </p>
          )}
          <p className="mt-4 text-center text-sm text-neutral-500">
            <Link href="/forgot-password" className="font-medium text-brand-700 hover:underline">
              {t('requestNewLink')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
