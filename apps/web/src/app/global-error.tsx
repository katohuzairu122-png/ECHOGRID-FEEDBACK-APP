'use client';

/**
 * Last-resort boundary: the only one that catches a throw in the ROOT
 * LAYOUT itself.
 *
 * Next.js replaces the entire root layout with this file when it fires, so
 * three things that are true everywhere else in this app are not true here,
 * and each one drives a decision below.
 *
 * 1. IT MUST RENDER ITS OWN <html> AND <body>. There is no layout above it
 *    to supply them.
 *
 * 2. THERE IS NO NextIntlClientProvider. It lives in the root layout, which
 *    is exactly what has been replaced -- so useTranslations() would throw
 *    inside the error boundary, turning a handled error into an unhandled
 *    one. The copy is therefore hardcoded English, deliberately, and this is
 *    the one file in the app where that is correct rather than the defect
 *    the audit flagged elsewhere. A root-layout failure is also very often a
 *    locale-resolution failure (i18n/request.ts runs there), so there may be
 *    no locale to translate into even in principle.
 *
 * 3. globals.css arrives via the root layout's import, so Tailwind classes
 *    cannot be relied on. Styles are inline for the same reason sw.js keeps
 *    its offline page's markup inline rather than in a second cache entry:
 *    a fallback that depends on the thing that just failed is not a
 *    fallback. No component imports either -- ErrorState needs both
 *    Tailwind and the intl provider.
 *
 * Kept deliberately plain. If this renders, something structural is wrong,
 * and the useful outcomes are "the page is legible" and "the user has a
 * reference to quote", not a designed experience.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '24px',
          font: '16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
          color: '#1f2937',
          background: '#f9fafb',
        }}
      >
        <main style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.5rem' }}>Something went wrong</h1>
          <p style={{ margin: '0 0 1.5rem', color: '#6b7280' }}>
            Echo Grid could not load this page. Try again, or come back in a moment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              font: 'inherit',
              fontWeight: 600,
              color: '#ffffff',
              background: '#1f2937',
              border: 'none',
              borderRadius: '0.5rem',
              padding: '0.625rem 1.25rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p style={{ margin: '1.5rem 0 0', fontSize: '0.75rem', color: '#9ca3af' }}>
              Reference {error.digest} — quote this if you contact support.
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
