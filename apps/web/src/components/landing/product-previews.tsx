import QRCode from 'react-qr-code';
import { Logo } from '@/components/brand';
import { APP_URL } from '@/lib/app-url';
import { LandingIcon, type LandingIconName } from './landing-icon';
import styles from './landing.module.css';
export interface PreviewCopy {
  example: string;
  customer: string;
  business: string;
  welcome: string;
  points: string;
  separate: string;
  feedback: string;
  rewards: string;
  activity: string;
  scan: string;
  dashboard: string;
  customers: string;
  responses: string;
  branches: string;
  satisfaction: string;
  trend: string;
  period: string;
  qrCaption: string;
}
/** Static illustrations only: no customer data, session, API call or economic authority. */
export function PhonePreview({ copy, compact = false }: { copy: PreviewCopy; compact?: boolean }) {
  const items: readonly [LandingIconName, string, string][] = [
    ['qr', copy.scan, 'mint'],
    ['chat', copy.feedback, 'blue'],
    ['gift', copy.rewards, 'gold'],
    ['chart', copy.activity, 'purple'],
  ];
  return (
    <figure
      className={`${styles.phone} ${compact ? styles.compactPhone : ''}`}
      aria-label={`${copy.customer} — ${copy.example}`}
    >
      <div className={styles.phoneNotch} />
      <div className={styles.phoneTop}>
        <Logo variant="dark" iconSize={17} />
        <LandingIcon name="bell" />
      </div>
      <div className={styles.welcome}>
        <span className={styles.avatar}>A</span>
        <div>
          {copy.welcome}
          <strong>Alex</strong>
        </div>
      </div>
      <div className={styles.balance}>
        <small>{copy.points}</small>
        <strong>
          <span>★</span> 240
        </strong>
        <p>{copy.separate}</p>
      </div>
      <div className={styles.phoneActions}>
        {items.map(([icon, label, tone]) => (
          <div key={icon}>
            <span className={`${styles.iconTile} ${styles[tone]}`}>
              <LandingIcon name={icon} />
            </span>
            <strong>{label}</strong>
            <span aria-hidden="true">›</span>
          </div>
        ))}
      </div>
      <div className={styles.phoneTabs} aria-hidden="true">
        <LandingIcon name="store" />
        <LandingIcon name="star" />
        <span>
          <LandingIcon name="qr" />
        </span>
        <LandingIcon name="chat" />
      </div>
      <figcaption>{copy.example}</figcaption>
      <div className={styles.homeIndicator} />
    </figure>
  );
}
export function QrPreview({ copy }: { copy: PreviewCopy }) {
  // Illustrative public-homepage code, NOT a branch QR identity or signed token.
  return (
    <figure className={styles.qrStand} aria-label={copy.qrCaption}>
      <Logo variant="dark" iconSize={25} />
      <div className={styles.qrCode} aria-hidden="true">
        <QRCode value={APP_URL} size={134} level="M" />
      </div>
      <strong>{copy.scan}</strong>
      <div className={styles.qrMiniIcons} aria-hidden="true">
        <LandingIcon name="star" />
        <LandingIcon name="chat" />
        <LandingIcon name="gift" />
      </div>
      <figcaption>{copy.qrCaption}</figcaption>
    </figure>
  );
}
export function DashboardPreview({ copy }: { copy: PreviewCopy }) {
  const stats: readonly [LandingIconName, string, string, string][] = [
    ['users', copy.customers, '1,248', 'mint'],
    ['chat', copy.responses, '892', 'blue'],
    ['store', copy.branches, '5', 'gold'],
    ['chart', copy.satisfaction, '4.8 / 5', 'purple'],
  ];
  return (
    <figure className={styles.dashboard} aria-label={`${copy.dashboard} — ${copy.example}`}>
      <aside aria-hidden="true">
        <Logo variant="dark" iconSize={18} />
        {(['chart', 'users', 'star', 'chat', 'bell', 'settings'] as const).map((icon, i) => (
          <div key={icon} className={i === 0 ? styles.selected : ''}>
            <LandingIcon name={icon} />
            <span>
              {
                [
                  copy.dashboard,
                  copy.customers,
                  copy.rewards,
                  copy.feedback,
                  copy.activity,
                  copy.branches,
                ][i]
              }
            </span>
          </div>
        ))}
      </aside>
      <div className={styles.dashboardBody}>
        <div className={styles.dashboardTitle}>
          <strong>{copy.dashboard}</strong>
          <span>{copy.period}</span>
        </div>
        <div className={styles.stats}>
          {stats.map(([icon, label, value, tone]) => (
            <div key={icon}>
              <span className={`${styles.iconTile} ${styles[tone]}`}>
                <LandingIcon name={icon} />
              </span>
              <div>
                <small>{label}</small>
                <strong>{value}</strong>
              </div>
            </div>
          ))}
        </div>
        <div className={styles.chart}>
          <div>
            <strong>{copy.trend}</strong>
            <span>{copy.example}</span>
          </div>
          <svg viewBox="0 0 560 130" preserveAspectRatio="none" role="img" aria-label={copy.trend}>
            <defs>
              <linearGradient id="landing-chart-fill" x1="0" y1="0" x2="0" y2="1">
                <stop stopColor="#10b981" stopOpacity=".3" />
                <stop offset="1" stopColor="#10b981" stopOpacity=".025" />
              </linearGradient>
            </defs>
            {[25, 55, 85, 115].map((y) => (
              <path key={y} d={`M0 ${y}h560`} stroke="#edf2f7" />
            ))}
            <path
              d="M0 120 C35 105 50 102 80 106 S130 97 160 90 S205 113 240 88 S285 61 320 70 S375 33 410 42 S450 63 480 36 S535 41 560 18 L560 130H0Z"
              fill="url(#landing-chart-fill)"
            />
            <path
              d="M0 120 C35 105 50 102 80 106 S130 97 160 90 S205 113 240 88 S285 61 320 70 S375 33 410 42 S450 63 480 36 S535 41 560 18"
              fill="none"
              stroke="#10b981"
              strokeWidth="2"
            />
          </svg>
        </div>
        <figcaption>{copy.example}</figcaption>
      </div>
    </figure>
  );
}
