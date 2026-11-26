import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../../messages/en/common.json';
import ar from '../../../messages/ar/common.json';
import es from '../../../messages/es/common.json';
import fr from '../../../messages/fr/common.json';
import { CampaignStatusCard } from './campaign-status-card';
import { disclosureText, parseCampaign } from '@/lib/tentaship-campaign-types';

const LOCALES = { en, ar, es, fr } as const;
const raw = { campaignId: 'c1', status: 'draft', termsVersion: 'draft-1', disclosure: { en: 'Recorded English disclosure.', ar: 'نص الإفصاح المسجل.' }, disclosureHash: 'a'.repeat(64), eligibility: 'met', participation: 'admitted', outcomeRecorded: false };
const show = (locale: keyof typeof LOCALES, input: unknown) => {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  return render(<div dir={dir} lang={locale}><NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ common: LOCALES[locale] }}><CampaignStatusCard result={parseCampaign(input)} /></NextIntlClientProvider></div>);
};
const keys = (o: unknown, p = ''): string[] => (o && typeof o === 'object' ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p.slice(0, -1)]);

describe('TSH-06 campaign status card (customer foundation)', () => {
  it('has the same message keys in all four languages (no missing translation)', () => {
    const base = keys(en.tentashipCampaign).sort();
    for (const l of ['ar', 'es', 'fr'] as const) expect(keys(LOCALES[l].tentashipCampaign).sort(), l).toEqual(base);
    for (const l of ['en', 'ar', 'es', 'fr'] as const) for (const v of Object.values(LOCALES[l].tentashipCampaign.status)) expect(v.length).toBeGreaterThan(0);
  });
  it.each(['en', 'ar', 'es', 'fr'] as const)('renders recorded values only, in %s, with no join/enter/claim/draw control and no odds, prize or guarantee wording', (l) => {
    const { container } = show(l, raw);
    expect(screen.getByTestId('campaign-status')).toBeInTheDocument();
    expect(screen.getByTestId('campaign-eligibility')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/guarantee|garant|ganad|gagnant|winner|prize|premio|prix|odds|probabilit|فوز|جائزة|مضمون/i);
    expect(container.textContent).toContain(l === 'ar' ? 'نص الإفصاح المسجل.' : 'Recorded English disclosure.'); // recorded disclosure verbatim, English fallback
  });
  it('Arabic renders inside an RTL container and uses logical alignment (no hard left/right classes)', () => {
    const { container } = show('ar', raw);
    expect(container.firstElementChild).toHaveAttribute('dir', 'rtl');
    expect(container.innerHTML).toContain('text-start');
    expect(container.innerHTML).not.toMatch(/\b(ml|mr|pl|pr|text-left|text-right)-/);
    expect(container.querySelector('[dir="ltr"]')).not.toBeNull(); // the hash reference stays left-to-right inside RTL
  });
  it('shows an honest unavailable state (never an invented success) for a missing, malformed or unknown value', () => {
    for (const bad of [null, {}, { ...raw, status: 'released' }, { ...raw, eligibility: 'maybe' }, { ...raw, participation: 'selected' }, { ...raw, disclosure: { en: 5 } }, { ...raw, outcomeRecorded: 'yes' }]) {
      const { unmount } = show('en', bad);
      expect(screen.getByText('This feature is not available right now.')).toBeInTheDocument();
      expect(screen.queryByTestId('campaign-status')).not.toBeInTheDocument();
      unmount();
    }
  });
  it('a suspended or cancelled campaign says so and still offers no action; the disclosure falls back to English', () => {
    show('fr', { ...raw, status: 'suspended', disclosure: { en: 'English only.' }, participation: 'none', eligibility: 'notEvaluated' });
    expect(screen.getByTestId('campaign-status')).toHaveTextContent('En pause');
    expect(screen.getByTestId('campaign-disclosure')).toHaveTextContent('English only.');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(disclosureText({ en: 'x' }, 'es')).toBe('x');
  });
});
