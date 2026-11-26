import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { createRequire } from 'node:module';
import tailwind from '@tailwindcss/postcss';
import en from '../../messages/en/common.json';
import ar from '../../messages/ar/common.json';
import es from '../../messages/es/common.json';
import fr from '../../messages/fr/common.json';
import { SponsorshipReport } from '../../src/components/tentaship-drops-report/sponsorship-report';
import { CampaignStatusCard } from '../../src/components/tentaship-campaign/campaign-status-card';
import { parseSponsorshipReport } from '../../src/lib/tentaship-drops-report-types';
import { parseCampaign } from '../../src/lib/tentaship-campaign-types';

/** Writes one static HTML page per component, state and language, using the app's OWN compiled Tailwind CSS. Synthetic data only. */
export const FIXTURE_DIR = path.resolve(__dirname, '../../node_modules/.cache/tentaship-component-fixtures');
const LOCALES = { en, ar, es, fr } as const;
const report = { sponsorshipId: 's1', status: 'available', metrics: { total: 120, available: 40, reserved: 20, allocated: 30, collected: 20, allocationsExpired: 10, reservationsCreated: 95, holdsReleased: 3, holdsExpired: 2, outstandingCollection: 30, collectionCompletionRate: 0.4, reconciled: true } };
const hiddenReport = { ...report, metrics: { ...report.metrics, reserved: { available: false, reason: 'SUPPRESSED_SMALL_GROUP' }, collectionCompletionRate: { available: false, reason: 'NO_ALLOCATION_YET' }, reconciled: false } };
const campaign = { campaignId: 'c1', status: 'draft', termsVersion: 'draft-1', disclosure: { en: 'The outcome is determined by the server after the entry deadline.', ar: 'يحدد الخادم النتيجة بعد الموعد النهائي للدخول.' }, disclosureHash: 'a'.repeat(64), eligibility: 'met', participation: 'admitted', outcomeRecorded: false };

// postcss is a dependency of @tailwindcss/postcss, not of this app: resolve it from that package (strict pnpm layout).
const postcss = createRequire(createRequire(__filename).resolve('@tailwindcss/postcss'))('postcss') as typeof import('postcss').default;

describe('render static fixtures for the real-browser spec', () => {
  it('writes every fixture', async () => {
    const from = path.resolve(__dirname, '../../src/app/globals.css');
    const css = (await postcss([tailwind({ base: path.resolve(__dirname, '../..') })]).process(readFileSync(from, 'utf8'), { from })).css;
    expect(css.length).toBeGreaterThan(1000);
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const page = (locale: keyof typeof LOCALES, body: React.ReactElement) => {
      const markup = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale, timeZone: 'UTC', messages: { common: LOCALES[locale] } }, body));
      return `<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-neutral-50 p-4"><main class="mx-auto max-w-xl space-y-4">${markup}</main></body></html>`;
    };
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      writeFileSync(path.join(FIXTURE_DIR, `report-${locale}.html`), page(locale, createElement(SponsorshipReport, { result: parseSponsorshipReport(report) })));
      writeFileSync(path.join(FIXTURE_DIR, `report-hidden-${locale}.html`), page(locale, createElement(SponsorshipReport, { result: parseSponsorshipReport(hiddenReport) })));
      writeFileSync(path.join(FIXTURE_DIR, `campaign-${locale}.html`), page(locale, createElement(CampaignStatusCard, { result: parseCampaign(campaign) })));
    }
  });
});
