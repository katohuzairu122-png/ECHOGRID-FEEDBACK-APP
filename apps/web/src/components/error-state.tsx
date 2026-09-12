'use client';

import { useTranslations } from 'next-intl';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

/**
 * The body every error.tsx in this app renders. Defined once so five
 * boundaries stay identical in copy, spacing and behaviour -- and so
 * changing the recovery wording is one edit rather than five.
 *
 * WHAT THIS RECEIVES, AND WHAT IT DELIBERATELY DOES NOT INSPECT
 * Next.js serialises the error across the server/client boundary before an
 * error boundary sees it, and in production it REPLACES the message with a
 * generic string, keeping only `digest`. So this component cannot branch on
 * the error: `instanceof ApiError` is always false here, `error.status` does
 * not survive, and a status-specific message would be correct in dev and a
 * lie in production. It shows one honest message instead.
 *
 * `digest` is the exception and the reason it is surfaced. It is a stable
 * hash of the server-side error, and the platform has no error reporting at
 * all today (audit P3-2: zero structured logging, no Sentry, Workers Logs
 * with no alerting), so this string is the ONLY handle correlating what a
 * user saw with what the Worker logged. A user quoting it in a support
 * message is currently the fastest path from a report to a cause.
 */
export function ErrorState({
  error,
  reset,
  className,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  className?: string;
}) {
  const t = useTranslations('common');

  return (
    <div className={className ?? 'flex min-h-[60vh] items-center justify-center p-6'}>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('error.title')}</CardTitle>
          <CardDescription>{t('error.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* reset() re-renders the boundary's children, which re-runs the
              failed server render. Correct for the transient cases this
              exists for (a timed-out API call, a deploy mid-request) and
              harmless otherwise -- it fails the same way again and the user
              is no worse off than the blank page they used to get. */}
          <Button type="button" onClick={reset} className="w-full">
            {t('actions.retry')}
          </Button>
          {error.digest ? (
            <p className="text-center text-xs text-neutral-500" role="note">
              {t('error.reference', { digest: error.digest })}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
