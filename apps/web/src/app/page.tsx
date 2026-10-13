import Link from 'next/link';
import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { hasSession } from '@/lib/session';
import { Logo } from '@/components/brand';
import { LandingIcon, type LandingIconName } from '@/components/landing/landing-icon';
import {
  DashboardPreview,
  PhonePreview,
  QrPreview,
  type PreviewCopy,
} from '@/components/landing/product-previews';
import styles from '@/components/landing/landing.module.css';
import { LANDING_PLANS } from '@/components/landing/landing-plans';

const FEATURE_ICONS = ['qr', 'star', 'chat', 'chart', 'bell', 'shield'] as const;
const STEP_ICONS = ['settings', 'qr', 'gift', 'chart'] as const;
const CUSTOMER_ICONS = ['store', 'star', 'chat', 'chart', 'shield', 'gift'] as const;
const INDUSTRY_ICONS = ['store', 'bag', 'fitness', 'bed', 'scissors', 'medical'] as const;
const LEGAL_LINKS = ['support', 'privacy', 'terms', 'refunds', 'cookies'] as const;

export default async function RootPage() {
  if (await hasSession()) redirect('/dashboard');
  const t = await getTranslations('landing.marketing');
  const copy: PreviewCopy = {
    example: t('preview.example'),
    customer: t('preview.customer'),
    business: t('preview.business'),
    welcome: t('preview.welcome'),
    points: t('preview.points'),
    separate: t('preview.separate'),
    feedback: t('preview.feedback'),
    rewards: t('preview.rewards'),
    activity: t('preview.activity'),
    scan: t('preview.scan'),
    dashboard: t('preview.dashboard'),
    customers: t('preview.customers'),
    responses: t('preview.responses'),
    branches: t('preview.branches'),
    satisfaction: t('preview.satisfaction'),
    trend: t('preview.trend'),
    period: t('preview.period'),
    qrCaption: t('preview.qrCaption'),
  };
  const nav = (
    <>
      <a href="#how-it-works">{t('nav.how')}</a>
      <a href="#features">{t('nav.features')}</a>
      <a href="#businesses">{t('nav.businesses')}</a>
      <a href="#customers">{t('nav.customers')}</a>
      <a href="#pricing">{t('nav.pricing')}</a>
      <Link href="/support">{t('nav.resources')}</Link>
    </>
  );
  const cta = (label: string) => (
    <Link href="/signup" className={styles.primaryCta}>
      {label}
      <LandingIcon name="arrow" />
    </Link>
  );
  const tile = (icon: LandingIconName, index: number) => (
    <span
      className={`${styles.iconTile} ${styles[['mint', 'gold', 'blue', 'purple', 'pink', 'mint'][index % 6]!]}`}
    >
      <LandingIcon name={icon} />
    </span>
  );
  return (
    <main className={styles.landing}>
      <a href="#main-content" className={styles.skipLink}>
        {t('skip')}
      </a>
      <div className={styles.heroShell}>
        <Image
          src="/landing/cafe-hero.webp"
          fill
          unoptimized
          preload
          sizes="100vw"
          alt=""
          className={styles.heroPhoto}
        />
        <div className={styles.heroShade} />
        <header className={styles.header}>
          <Link href="/" aria-label={t('home')} className={styles.brand}>
            <Logo variant="dark" iconSize={36} />
          </Link>
          <nav aria-label={t('mainNav')} className={styles.desktopNav}>
            {nav}
          </nav>
          <div className={styles.headerActions}>
            <Link href="/login" className={styles.signIn}>
              {t('nav.signIn')}
            </Link>
            <Link href="/signup" className={styles.smallCta}>
              {t('nav.start')}
            </Link>
          </div>
          <details className={styles.mobileMenu}>
            <summary>
              {t('nav.menu')}
              <span aria-hidden="true">☰</span>
            </summary>
            <nav aria-label={t('mainNav')}>
              {nav}
              <Link href="/login">{t('nav.signIn')}</Link>
              <Link href="/signup">{t('nav.start')}</Link>
            </nav>
          </details>
        </header>
        <section id="main-content" tabIndex={-1} className={styles.hero}>
          <div className={styles.heroCopy}>
            <h1>
              {t('hero.title')}
              <br />
              <span>{t('hero.accent')}</span>
            </h1>
            <p>{t('hero.description')}</p>
            <div className={styles.ctaRow}>
              {cta(t('startFree'))}
              <a href="#how-it-works" className={styles.outlineCta}>
                <LandingIcon name="play" />
                {t('hero.watch')}
              </a>
            </div>
            <div className={styles.heroProof}>
              {(['store', 'chart', 'users'] as const).map((icon, i) => (
                <div key={icon}>
                  <LandingIcon name={icon} />
                  <span>{t(`hero.proof${i}`)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.heroVisual}>
            <PhonePreview copy={copy} />
            <QrPreview copy={copy} />
          </div>
        </section>
      </div>
      <section
        id="features"
        className={`${styles.section} ${styles.features}`}
        aria-labelledby="features-title"
      >
        <div className={styles.sectionHeading}>
          <h2 id="features-title">{t('features.title')}</h2>
          <p>{t('features.subtitle')}</p>
        </div>
        <div className={styles.featureGrid}>
          {FEATURE_ICONS.map((icon, i) => (
            <article key={icon}>
              {tile(icon, i)}
              <h3>{t(`features.items.${i}.title`)}</h3>
              <p>{t(`features.items.${i}.description`)}</p>
            </article>
          ))}
        </div>
      </section>
      <section
        id="businesses"
        className={`${styles.section} ${styles.businessSection}`}
        aria-labelledby="business-title"
      >
        <div className={styles.businessGrid}>
          <DashboardPreview copy={copy} />
          <div className={styles.sectionCopy}>
            <span className={styles.eyebrow}>{t('business.eyebrow')}</span>
            <h2 id="business-title">
              {t('business.title')}
              <br />
              <span>{t('business.accent')}</span>
            </h2>
            <p>{t('business.description')}</p>
            <ul className={styles.checkList}>
              {[0, 1, 2, 3].map((i) => (
                <li key={i}>
                  <LandingIcon name="check" />
                  {t(`business.points.${i}`)}
                </li>
              ))}
            </ul>
            {cta(t('business.cta'))}
          </div>
        </div>
      </section>
      <section
        id="how-it-works"
        className={`${styles.section} ${styles.process}`}
        aria-labelledby="process-title"
      >
        <div className={styles.sectionHeading}>
          <span className={styles.eyebrow}>{t('process.eyebrow')}</span>
          <h2 id="process-title">
            {t('process.title')} <span>{t('process.accent')}</span>
          </h2>
          <p>{t('process.subtitle')}</p>
        </div>
        <ol className={styles.steps}>
          {STEP_ICONS.map((icon, i) => (
            <li key={icon}>
              <span className={styles.stepNumber}>{i + 1}</span>
              <div>
                <h3>{t(`process.items.${i}.title`)}</h3>
                <p>{t(`process.items.${i}.description`)}</p>
              </div>
              {tile(icon, i)}
            </li>
          ))}
        </ol>
      </section>
      <section
        id="customers"
        className={`${styles.section} ${styles.customerSection}`}
        aria-labelledby="customer-title"
      >
        <div className={styles.customerGrid}>
          <div className={styles.sectionCopy}>
            <span className={styles.eyebrow}>{t('customer.eyebrow')}</span>
            <h2 id="customer-title">
              {t('customer.title')}
              <br />
              <span>{t('customer.accent')}</span>
            </h2>
            <p>{t('customer.description')}</p>
            <Link href="/loyalty/login" className={styles.primaryCta}>
              {t('customer.cta')}
              <LandingIcon name="arrow" />
            </Link>
          </div>
          <div className={styles.customerPhone}>
            <PhonePreview copy={copy} compact />
          </div>
          <div className={styles.customerBenefits}>
            <h3>{t('customer.benefitsTitle')}</h3>
            <div>
              {CUSTOMER_ICONS.map((icon, i) => (
                <article key={`${icon}-${i}`}>
                  {tile(icon, i)}
                  <div>
                    <h4>{t(`customer.items.${i}.title`)}</h4>
                    <p>{t(`customer.items.${i}.description`)}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section
        className={`${styles.section} ${styles.industries}`}
        aria-labelledby="industry-title"
      >
        <div className={styles.sectionHeading}>
          <span className={styles.eyebrow}>{t('industry.eyebrow')}</span>
          <h2 id="industry-title">{t('industry.title')}</h2>
          <p>{t('industry.subtitle')}</p>
        </div>
        <div className={styles.industryGrid}>
          {INDUSTRY_ICONS.map((icon, i) => (
            <article key={icon}>
              <div
                className={styles.industryPhoto}
                style={{ backgroundPosition: `${i * 20}% center` }}
                aria-hidden="true"
              />
              {tile(icon, i)}
              <h3>{t(`industry.items.${i}.title`)}</h3>
              <p>{t(`industry.items.${i}.description`)}</p>
            </article>
          ))}
        </div>
      </section>
      <section
        id="pricing"
        className={`${styles.section} ${styles.pricing}`}
        aria-labelledby="pricing-title"
      >
        <div className={styles.sectionHeading}>
          <h2 id="pricing-title">{t('pricing.title')}</h2>
          <p>{t('pricing.subtitle')}</p>
        </div>
        <div className={styles.planGrid}>
          {LANDING_PLANS.map(({ key, monthlyCents }) => (
            <article key={key}>
              <h3>{t(`pricing.${key}`)}</h3>
              <p>
                <strong>
                  {monthlyCents === null ? t('pricing.custom') : `$${monthlyCents / 100}`}
                </strong>
                {monthlyCents !== null && <span> {t('pricing.month')}</span>}
              </p>
              <Link href={key === 'enterprise' ? '/support' : '/signup'}>
                {key === 'enterprise' ? t('pricing.contact') : t('nav.start')}
                <LandingIcon name="arrow" />
              </Link>
            </article>
          ))}
        </div>
        <p className={styles.pricingNote}>{t('pricing.note')}</p>
      </section>
      <section className={styles.finalCta} aria-labelledby="final-title">
        <div>
          <h2 id="final-title">
            {t('final.title')} <span>{t('final.accent')}</span>
          </h2>
          <p>{t('final.description')}</p>
        </div>
        {cta(t('startFree'))}
      </section>
      <footer className={styles.footer}>
        <div className={styles.footerBrand}>
          <Logo variant="horizontal" iconSize={29} />
          <p>{t('footer.company')}</p>
        </div>
        <nav aria-label={t('footer.legal')}>
          {LEGAL_LINKS.map((key) => (
            <Link key={key} href={`/${key}`}>
              {t(`footer.${key}`)}
            </Link>
          ))}
        </nav>
        <p>{t('footer.copyright')}</p>
      </footer>
    </main>
  );
}
