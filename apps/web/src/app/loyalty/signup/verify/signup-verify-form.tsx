'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { completeEmailRegistrationAction, type EmailAuthState } from '@/lib/actions/customer-email-auth';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { Logo } from '@/components/brand';
import { LanguageSelector } from '@/components/language-selector';

const initial: EmailAuthState = {};

/** Reads `#c=<challengeId>.<proof>` and removes it from the address bar at once, so the proof is not kept in history. */
export function readChallengeFromHash(hash: string): string | null {
  const match = /^#c=([^&]+)$/.exec(hash);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]!);
    return /^[0-9a-fA-F-]{36}\.[A-Za-z0-9_-]{16,}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function SignupVerifyForm({ next }: { next: string; minLength?: number | undefined }) {
  const [state, formAction, pending] = useActionState(completeEmailRegistrationAction, initial);
  const t = useTranslations('loyalty.customer.emailAuth');
  const [challenge, setChallenge] = useState<string | null | undefined>(undefined);
  const challengeRead = useRef(false);

  useEffect(() => {
    // React Strict Mode replays effects in development. Consume the fragment once,
    // otherwise the replay sees the already-scrubbed URL and overwrites the proof.
    if (challengeRead.current) return;
    challengeRead.current = true;
    setChallenge(readChallengeFromHash(window.location.hash));
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  // Same-document navigation to another email link changes only the fragment.
  // Next.js may reuse this component, so the initial mount effect will not rerun.
  // Accept a newly opened proof without retaining the fragment in browser history.
  useEffect(() => {
    const onHashChange = () => {
      setChallenge(readChallengeFromHash(window.location.hash));
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (state.success && state.next) window.location.assign(state.next);
  }, [state]);

  if (challenge === undefined) return null; // not read yet (server render has no fragment)

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-8">
      <LanguageSelector className="w-40 self-end" />
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('verifyTitle')}</CardTitle>
          <CardDescription>{challenge ? t('verifyDescription') : t('missingLink')}</CardDescription>
        </CardHeader>
        <CardContent>
          {challenge ? (
            <form action={formAction} className="flex flex-col gap-4">
              <input type="hidden" name="challenge" value={challenge} />
              <input type="hidden" name="next" value={next} />
              {state.error && (
                <p role="alert" className="text-sm text-danger">
                  {t(`errors.${state.error}`, { min: state.minLength ?? 0 })}
                </p>
              )}
              <Button type="submit" disabled={pending || state.success === true} className="w-full">
                {pending ? t('creating') : t('createAccountButton')}
              </Button>
              <Link href={`/loyalty/signup?next=${encodeURIComponent(next)}`} className="text-center text-sm font-medium text-brand-700 hover:underline">
                {t('requestNewLink')}
              </Link>
            </form>
          ) : (
            <Link href={`/loyalty/signup?next=${encodeURIComponent(next)}`} className="text-sm font-medium text-brand-700 hover:underline">
              {t('requestNewLink')}
            </Link>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
