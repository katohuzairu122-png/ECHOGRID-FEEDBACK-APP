import { describe, it, expect, vi } from 'vitest';

// The programme form imports a server action; the static fixture renders the form only, so the action is a stub here.
vi.mock('../../src/lib/actions/loyalty-programmes', () => ({ programmeAction: async () => ({}) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement('a', { href, ...rest }, children as never) }));
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
import enLoyalty from '../../messages/en/loyalty.json';
import arLoyalty from '../../messages/ar/loyalty.json';
import esLoyalty from '../../messages/es/loyalty.json';
import frLoyalty from '../../messages/fr/loyalty.json';
import { ProgrammeCards } from '../../src/components/loyalty-programmes/programme-cards';
import { ProgrammeForm } from '../../src/components/loyalty-programmes/programme-form';
import { ActiveProgrammePanel } from '../../src/components/loyalty-programmes/programme-panels';
import { SponsorshipReport } from '../../src/components/tentaship-drops-report/sponsorship-report';
import { CampaignStatusCard } from '../../src/components/tentaship-campaign/campaign-status-card';
import { parseSponsorshipReport } from '../../src/lib/tentaship-drops-report-types';
import { parseCampaign } from '../../src/lib/tentaship-campaign-types';
import { SponsorApplicationStatus } from '../../src/components/tentaship-governance/sponsor-application-status';
import { GovernanceCaseSummary } from '../../src/components/tentaship-governance/governance-case-summary';
import { parseGovernanceCase, parseSponsorApplication } from '../../src/lib/tentaship-governance-types';

/** Writes one static HTML page per component, state and language, using the app's OWN compiled Tailwind CSS. Synthetic data only. */
export const FIXTURE_DIR = path.resolve(__dirname, '../../node_modules/.cache/tentaship-component-fixtures');
const LOCALES = { en, ar, es, fr } as const;
const LOYALTY = { en: enLoyalty, ar: arLoyalty, es: esLoyalty, fr: frLoyalty } as const;
const REGISTRY = [...(['LP-01', 'LP-02', 'LP-03', 'LP-04', 'LP-05', 'LP-06', 'LP-07'] as const).map((type) => ({ type, available: true })), { type: 'LP-08' as const, available: false, unavailableReason: 'NEEDS_ITEM_LEVEL_EVIDENCE' as const }];
const PRIZES = [{ id: '6f0f1c5e-0000-4000-8000-0000000000a1', name: 'Free coffee' }, { id: '6f0f1c5e-0000-4000-8000-0000000000a2', name: 'Voucher' }];
const report = { sponsorshipId: 's1', status: 'available', metrics: { total: 120, available: 40, reserved: 20, allocated: 30, collected: 20, allocationsExpired: 10, reservationsCreated: 95, holdsReleased: 3, holdsExpired: 2, outstandingCollection: 30, collectionCompletionRate: 0.4, reconciled: true } };
const hiddenReport = { ...report, metrics: { ...report.metrics, reserved: { available: false, reason: 'SUPPRESSED_SMALL_GROUP' }, collectionCompletionRate: { available: false, reason: 'NO_ALLOCATION_YET' }, reconciled: false } };
const campaign = { campaignId: 'c1', status: 'draft', termsVersion: 'draft-1', disclosure: { en: 'The outcome is determined by the server after the entry deadline.', ar: 'يحدد الخادم النتيجة بعد الموعد النهائي للدخول.' }, disclosureHash: 'a'.repeat(64), eligibility: 'met', participation: 'admitted', outcomeRecorded: false };

const sponsorApp = { status: 'suspended', reason: 'Recorded synthetic reason for the suspension.', changedAt: '2026-11-26T08:00:00.000Z' };
const govCase = { kind: 'fraud', status: 'decided', decision: 'upheld', evidenceCount: 2, policyVersion: 3, chain: 'ok' };
const govBroken = { kind: 'dispute', status: 'open', decision: null, evidenceCount: 0, policyVersion: null, chain: 'broken' };

// postcss is a dependency of @tailwindcss/postcss, not of this app: resolve it from that package (strict pnpm layout).
const postcss = createRequire(createRequire(__filename).resolve('@tailwindcss/postcss'))('postcss') as (plugins: unknown[]) => { process(css: string, o: { from: string }): Promise<{ css: string }> };

describe('render static fixtures for the real-browser spec', () => {
  it('writes every fixture', async () => {
    const from = path.resolve(__dirname, '../../src/app/globals.css');
    const css = (await postcss([tailwind({ base: path.resolve(__dirname, '../..') })]).process(readFileSync(from, 'utf8'), { from })).css;
    expect(css.length).toBeGreaterThan(1000);
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const page = (locale: keyof typeof LOCALES, body: React.ReactElement) => {
      const markup = renderToStaticMarkup(createElement(NextIntlClientProvider as never, { locale, timeZone: 'UTC', messages: { common: LOCALES[locale], loyalty: LOYALTY[locale] } } as never, body));
      return `<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-neutral-50 p-4"><main class="mx-auto max-w-xl space-y-4">${markup}</main></body></html>`;
    };
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      writeFileSync(path.join(FIXTURE_DIR, `report-${locale}.html`), page(locale, createElement(SponsorshipReport, { result: parseSponsorshipReport(report) })));
      writeFileSync(path.join(FIXTURE_DIR, `report-hidden-${locale}.html`), page(locale, createElement(SponsorshipReport, { result: parseSponsorshipReport(hiddenReport) })));
      writeFileSync(path.join(FIXTURE_DIR, `campaign-${locale}.html`), page(locale, createElement(CampaignStatusCard, { result: parseCampaign(campaign) })));
      writeFileSync(path.join(FIXTURE_DIR, `governance-${locale}.html`), page(locale, createElement('div', { className: 'space-y-4' }, createElement(SponsorApplicationStatus, { result: parseSponsorApplication(sponsorApp) }), createElement(GovernanceCaseSummary, { result: parseGovernanceCase(govCase) }))));
      writeFileSync(path.join(FIXTURE_DIR, `programme-cards-${locale}.html`), page(locale, createElement('div', { className: 'space-y-4' }, createElement(ActiveProgrammePanel, { active: undefined }), createElement(ProgrammeCards, { registry: REGISTRY, activeType: 'LP-03' }))));
      writeFileSync(path.join(FIXTURE_DIR, `programme-lp06-${locale}.html`), page(locale, createElement(ProgrammeForm, { type: 'LP-06', config: {}, rewards: PRIZES, currency: 'KWD', replaces: 'LP-03' })));
      writeFileSync(path.join(FIXTURE_DIR, `programme-lp04-${locale}.html`), page(locale, createElement(ProgrammeForm, { type: 'LP-04', config: {}, rewards: PRIZES, currency: 'KWD' })));
      writeFileSync(path.join(FIXTURE_DIR, `governance-broken-${locale}.html`), page(locale, createElement(GovernanceCaseSummary, { result: parseGovernanceCase(govBroken) })));
    }
  });
});
