'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  cancelCustomerRecoveryAction,
  completeCustomerRecoveryAction,
  requestRecoveryEmailAction,
  requestRecoveryPhoneAction,
  startCustomerRecoveryAction,
  verifyRecoveryCodeAction,
  verifyRecoveryEmailAction,
  verifyRecoveryPhoneAction,
  type RecoveryState,
} from '@/lib/actions/customer-recovery';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui';
import { LanguageSelector } from '@/components/language-selector';
import { Logo } from '@/components/brand';

const initial: RecoveryState = {};

export function CustomerRecoveryStartForm() {
  const [state, action, pending] = useActionState(startCustomerRecoveryAction, initial);
  const [identifier, setIdentifier] = useState<'email' | 'phone'>('email');
  const t = useTranslations('loyalty.customer.accountRecovery');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-5 sm:p-8">
      <LanguageSelector className="w-40 self-end" />
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {state.started && state.attemptId ? (
            <RecoveryFactors attemptId={state.attemptId} />
          ) : (
            <form action={action} className="flex flex-col gap-4">
              <p className="text-sm text-neutral-700">{t('genericNotice')}</p>
              <div className="flex gap-2" role="group" aria-label={t('identifierChoice')}>
                <Button
                  type="button"
                  variant={identifier === 'email' ? 'primary' : 'outline'}
                  aria-pressed={identifier === 'email'}
                  onClick={() => setIdentifier('email')}
                >
                  {t('emailChoice')}
                </Button>
                <Button
                  type="button"
                  variant={identifier === 'phone' ? 'primary' : 'outline'}
                  aria-pressed={identifier === 'phone'}
                  onClick={() => setIdentifier('phone')}
                >
                  {t('phoneChoice')}
                </Button>
              </div>
              {identifier === 'email' ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="recovery-email">{t('emailLabel')}</Label>
                  <Input
                    id="recovery-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="recovery-phone">{t('phoneLabel')}</Label>
                  <Input
                    id="recovery-phone"
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                    placeholder="+15551234567"
                    required
                  />
                </div>
              )}
              {state.error && (
                <p role="alert" className="text-sm text-danger">
                  {t(`errors.${state.error}`)}
                </p>
              )}
              <Button type="submit" disabled={pending}>
                {pending ? t('working') : t('start')}
              </Button>
            </form>
          )}
          <p className="mt-5 text-center text-sm">
            <Link
              href="/loyalty/login/email"
              className="font-medium text-brand-700 hover:underline"
            >
              {t('backToSignIn')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

function RecoveryFactors({
  attemptId,
  initialProof = '',
}: {
  attemptId: string;
  initialProof?: string;
}) {
  const t = useTranslations('loyalty.customer.accountRecovery');
  const [emailState, emailAction, emailPending] = useActionState(
    requestRecoveryEmailAction,
    initial,
  );
  const [phoneState, phoneAction, phonePending] = useActionState(
    requestRecoveryPhoneAction,
    initial,
  );
  const [factor, factorAction, factorPending] = useActionState(verifyRecoveryCodeAction, initial);
  const [phoneProof, phoneProofAction, phoneProofPending] = useActionState(
    verifyRecoveryPhoneAction,
    initial,
  );
  const [proof] = useState(initialProof);
  const [emailProof, emailProofAction, emailProofPending] = useActionState(
    verifyRecoveryEmailAction,
    initial,
  );
  const [holdExpired, setHoldExpired] = useState(false);
  const statuses = [emailProof.status, phoneProof.status, factor.status];
  const active = statuses.includes('security_hold')
    ? 'security_hold'
    : statuses.includes('factors_verified')
      ? 'factors_verified'
      : statuses.includes('awaiting_factors')
        ? 'awaiting_factors'
        : undefined;
  const holdUntil =
    emailProof.status === 'security_hold'
      ? emailProof.holdUntil
      : phoneProof.status === 'security_hold'
        ? phoneProof.holdUntil
        : factor.status === 'security_hold'
          ? factor.holdUntil
          : undefined;

  useEffect(() => {
    if (!holdUntil) return;
    const check = () => setHoldExpired(Date.parse(holdUntil) <= Date.now());
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
  }, [holdUntil]);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-neutral-700">{t('factorInstructions')}</p>
      {!proof && !emailProof.status && !phoneProof.status && !factor.status && (
        <form action={emailAction} className="flex flex-col gap-3 rounded-md border p-4">
          <input type="hidden" name="attemptId" value={attemptId} />
          <h2 className="font-medium">{t('emailFactor')}</h2>
          <p className="text-sm text-neutral-600">{t('emailFactorDescription')}</p>
          {emailState.sent && (
            <p role="status" className="text-sm">
              {t('proofSent')}
            </p>
          )}
          {emailState.error && (
            <p role="alert" className="text-sm text-danger">
              {t(`errors.${emailState.error}`)}
            </p>
          )}
          <Button type="submit" variant="outline" disabled={emailPending}>
            {emailPending ? t('working') : t('sendEmailProof')}
          </Button>
        </form>
      )}
      {proof && !emailProof.status && (
        <form action={emailProofAction} className="flex flex-col gap-3 rounded-md border p-4">
          <input type="hidden" name="proof" value={proof} />
          <h2 className="font-medium">{t('confirmEmail')}</h2>
          {emailProof.error && (
            <p role="alert" className="text-sm text-danger">
              {t(`errors.${emailProof.error}`)}
            </p>
          )}
          <Button type="submit" disabled={emailProofPending}>
            {emailProofPending ? t('working') : t('confirmEmail')}
          </Button>
        </form>
      )}
      {!phoneProof.status && !factor.status && (
        <form action={phoneAction} className="flex flex-col gap-3 rounded-md border p-4">
          <input type="hidden" name="attemptId" value={attemptId} />
          <h2 className="font-medium">{t('phoneFactor')}</h2>
          {phoneState.sent && (
            <p role="status" className="text-sm">
              {t('phoneCodeSent')}
            </p>
          )}
          {phoneState.error && (
            <p role="alert" className="text-sm text-danger">
              {t(`errors.${phoneState.error}`)}
            </p>
          )}
          <Button type="submit" variant="outline" disabled={phonePending}>
            {phonePending ? t('working') : t('sendPhoneCode')}
          </Button>
        </form>
      )}
      {phoneState.sent && !phoneProof.status && !factor.status && (
        <form action={phoneProofAction} className="flex flex-col gap-3 rounded-md border p-4">
          <input type="hidden" name="attemptId" value={attemptId} />
          <Label htmlFor="recovery-phone-code">{t('phoneCodeLabel')}</Label>
          <Input
            id="recovery-phone-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{4,10}"
            required
          />
          {phoneProof.error && (
            <p role="alert" className="text-sm text-danger">
              {t(`errors.${phoneProof.error}`)}
            </p>
          )}
          <Button type="submit" disabled={phoneProofPending}>
            {phoneProofPending ? t('working') : t('verifyPhoneCode')}
          </Button>
        </form>
      )}
      {!factor.status && (
        <form action={factorAction} className="flex flex-col gap-3 rounded-md border p-4">
          <input type="hidden" name="attemptId" value={attemptId} />
          <h2 className="font-medium">{t('recoveryCodeFactor')}</h2>
          <Label htmlFor="recovery-code">{t('recoveryCodeLabel')}</Label>
          <Input id="recovery-code" name="code" autoComplete="one-time-code" required />
          {factor.error && (
            <p role="alert" className="text-sm text-danger">
              {t(`errors.${factor.error}`)}
            </p>
          )}
          <Button type="submit" variant="outline" disabled={factorPending}>
            {factorPending ? t('working') : t('verifyRecoveryCode')}
          </Button>
        </form>
      )}
      {active === 'awaiting_factors' && (
        <p role="status" className="text-sm">
          {t('oneMoreFactor')}
        </p>
      )}
      {active === 'security_hold' && holdUntil && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          {holdExpired
            ? t('holdEnded')
            : t('holdUntil', { date: new Date(holdUntil).toLocaleString() })}
        </p>
      )}
      {active === 'factors_verified' || (active === 'security_hold' && holdExpired) ? (
        <PasswordReset
          attemptId={attemptId}
          disabled={active === 'security_hold' && !holdExpired}
        />
      ) : null}
    </div>
  );
}

export function RecoveryEmailLanding() {
  const [link, setLink] = useState<{ attemptId: string; proof: string } | null>(null);
  const t = useTranslations('loyalty.customer.accountRecovery');
  const parsed = useRef(false);
  useEffect(() => {
    if (parsed.current) return;
    parsed.current = true;
    const raw = new URLSearchParams(window.location.hash.slice(1)).get('c') ?? '';
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    const [attemptId = '', challengeId = '', proof = ''] = raw.split('.');
    if (
      /^[0-9a-f-]{36}$/i.test(attemptId) &&
      /^[0-9a-f-]{36}$/i.test(challengeId) &&
      proof.length >= 6 &&
      proof.length <= 256
    ) {
      setLink({ attemptId, proof: `${attemptId}.${challengeId}.${proof}` });
    }
  }, []);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-5 sm:p-8">
      <LanguageSelector className="w-40 self-end" />
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {link ? (
            <RecoveryFactors attemptId={link.attemptId} initialProof={link.proof} />
          ) : (
            <p role="alert" className="text-sm text-danger">
              {t('invalidLink')}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function PasswordReset({ attemptId, disabled }: { attemptId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(completeCustomerRecoveryAction, initial);
  const t = useTranslations('loyalty.customer.accountRecovery');
  if (state.completed)
    return (
      <p role="status" className="rounded-md bg-emerald-50 p-3 text-sm">
        {t('completed')}{' '}
        <Link className="underline" href="/loyalty/login/email">
          {t('signIn')}
        </Link>
      </p>
    );
  return (
    <form action={action} className="flex flex-col gap-3 rounded-md border p-4">
      <input type="hidden" name="attemptId" value={attemptId} />
      <h2 className="font-medium">{t('resetPassword')}</h2>
      <Label htmlFor="recovery-new-password">{t('newPassword')}</Label>
      <Input
        id="recovery-new-password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
      />
      <Label htmlFor="recovery-confirm-password">{t('confirmPassword')}</Label>
      <Input
        id="recovery-confirm-password"
        name="confirmation"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
      />
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {t(`errors.${state.error}`)}
        </p>
      )}
      <Button type="submit" disabled={pending || disabled}>
        {pending ? t('working') : t('completeReset')}
      </Button>
    </form>
  );
}

export function RecoveryCancellationForm() {
  const [state, action, pending] = useActionState(cancelCustomerRecoveryAction, initial);
  const [credential, setCredential] = useState('');
  const t = useTranslations('loyalty.customer.accountRecovery');
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current || !window.location.hash.startsWith('#c=')) return;
    consumed.current = true;
    const value = new URLSearchParams(window.location.hash.slice(1)).get('c') ?? '';
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setCredential(value);
  }, []);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 p-5 sm:p-8">
      <LanguageSelector className="w-40 self-end" />
      <Logo variant="full" iconSize={40} />
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t('cancelTitle')}</CardTitle>
          <CardDescription>{t('cancelDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {state.cancelled ? (
            <p role="status">{t('cancelled')}</p>
          ) : (
            <form action={action} className="flex flex-col gap-4">
              <input type="hidden" name="credential" value={credential} />
              {!credential && (
                <p role="alert" className="text-sm text-danger">
                  {t('invalidLink')}
                </p>
              )}
              {state.error && (
                <p role="alert" className="text-sm text-danger">
                  {t(`errors.${state.error}`)}
                </p>
              )}
              <Button type="submit" variant="outline" disabled={!credential || pending}>
                {pending ? t('working') : t('cancelAction')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
