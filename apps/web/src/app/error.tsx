'use client';

import { ErrorState } from '@/components/error-state';

/**
 * The app-wide error boundary. Catches any uncaught throw below the root
 * layout that a nearer boundary has not claimed -- so the public surface
 * (/, /login, /signup, /forgot-password, /reset-password, /feedback/[token],
 * /loyalty/[token]) lands here, and so does anything the three segment
 * boundaries below it do not cover.
 *
 * Until this file existed there was no error.tsx anywhere in the app, while
 * 26 of 34 pages awaited an API call at top level with no try/catch and
 * parseEnvelope throws on any non-2xx (audit P1-1). One timeout, one 500, or
 * one request landing mid-deploy escalated past every segment to the
 * framework's own fallback. On the anonymous QR pages that is the first
 * thing a real customer sees after scanning a business's code.
 *
 * Renders INSIDE the root layout, so NextIntlClientProvider is above it and
 * the copy is translated. app/global-error.tsx handles the narrower case
 * where the root layout itself is what threw.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} className="flex min-h-screen items-center justify-center bg-neutral-50 p-6" />;
}
