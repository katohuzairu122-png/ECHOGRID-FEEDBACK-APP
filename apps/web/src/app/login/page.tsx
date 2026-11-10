'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { loginAction, type AuthActionState } from '@/lib/actions/auth';
import { Button, Input, Label } from '@/components/ui';
import { Logo } from '@/components/brand';
import { LandingIcon } from '@/components/landing/landing-icon';
import styles from './login.module.css';

const initialState: AuthActionState = {};

export default function LoginPage() {
  const [next, setNext] = useState('/dashboard');
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('next');
    if (requested?.startsWith('/') && !requested.startsWith('//')) setNext(requested);
  }, []);
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const [showPassword, setShowPassword] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // i18n & Multi-Currency Block 4. state.error itself stays untranslated --
  // it's the API's raw error message, not a UI string this component owns;
  // see docs note in i18n & Multi-Currency's Block 4 completion summary.
  const t = useTranslations('auth.login');
  const error = state.errorKey ? t(state.errorKey) : state.error;
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [state, error]);

  return (
    <main className={styles.page}>
      <aside className={styles.brandPanel} aria-labelledby="login-brand-title">
        <Link href="/" aria-label={t('backHome')} className={styles.brandLink}>
          <Logo variant="dark" iconSize={40} />
        </Link>
        <div className={styles.brandCopy}>
          <p className={styles.eyebrow}>{t('brandEyebrow')}</p>
          <h2 id="login-brand-title">{t('brandTitle')}</h2>
          <p className={styles.brandDescription}>{t('brandDescription')}</p>
          <div className={styles.connectionArt} aria-hidden="true">
            <div className={styles.orbit} />
            <span className={styles.centralTile}>
              <LandingIcon name="qr" width={64} height={64} />
            </span>
            <span className={styles.feedbackTile}>
              <LandingIcon name="chat" width={28} height={28} />
            </span>
            <span className={styles.loyaltyTile}>
              <LandingIcon name="star" width={28} height={28} />
            </span>
            <span className={styles.insightsTile}>
              <LandingIcon name="chart" width={28} height={28} />
            </span>
          </div>
          <ul className={styles.features}>
            {(['chat', 'star', 'chart'] as const).map((icon, index) => (
              <li key={icon}>
                <LandingIcon name={icon} width={20} height={20} />
                {t((['featureFeedback', 'featureLoyalty', 'featureInsights'] as const)[index]!)}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className={styles.formPanel} aria-labelledby="login-title">
        <Link href="/" className={styles.backLink}>
          <span aria-hidden="true">←</span> {t('backHome')}
        </Link>
        <div className={styles.formCard}>
          <header className={styles.formHeader}>
            <p className={styles.formEyebrow}>{t('formEyebrow')}</p>
            <h1 id="login-title">{t('title')}</h1>
            <p>{t('description')}</p>
          </header>
          <form action={formAction} className={styles.form} aria-busy={pending}>
            <input type="hidden" name="next" value={next} />
            <div className={styles.field}>
              <Label htmlFor="email">{t('emailLabel')}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="you@business.com"
                className={styles.input}
                disabled={pending}
                required
              />
            </div>
            <div className={styles.field}>
              <div className={styles.passwordLabel}>
                <Label htmlFor="password">{t('passwordLabel')}</Label>
                <Link href="/forgot-password" className={styles.textLink}>
                  {t('forgotPasswordLink')}
                </Link>
              </div>
              <div className={styles.passwordInput}>
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  className={styles.input}
                  disabled={pending}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  className={styles.visibilityToggle}
                  aria-label={t(showPassword ? 'hidePassword' : 'showPassword')}
                  aria-controls="password"
                  aria-pressed={showPassword}
                  disabled={pending}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="3" />
                    {showPassword && <path d="m3 3 18 18" />}
                  </svg>
                </Button>
              </div>
            </div>
            {error && (
              <p ref={errorRef} role="alert" tabIndex={-1} className={styles.error}>
                {error}
              </p>
            )}
            <Button type="submit" disabled={pending} className={styles.submit}>
              {pending && <span className={styles.spinner} aria-hidden="true" />}
              {pending ? t('submitPending') : t('submit')}
              {!pending && <LandingIcon name="arrow" width={20} height={20} />}
            </Button>
          </form>
          <p className={styles.signup}>
            {t('noAccount')}{' '}
            <Link href={`/signup?next=${encodeURIComponent(next)}`} className={styles.textLink}>
              {t('signupLink')}
            </Link>
          </p>
        </div>
        <footer className={styles.footer}>
          <Link href="/support">{t('supportLink')}</Link>
          <nav aria-label={t('legalLabel')}>
            <Link href="/privacy">{t('privacyLink')}</Link>
            <Link href="/terms">{t('termsLink')}</Link>
          </nav>
        </footer>
      </section>
    </main>
  );
}
