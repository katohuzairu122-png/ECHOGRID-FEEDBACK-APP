import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../../messages/en/common.json';
import ar from '../../../messages/ar/common.json';
import es from '../../../messages/es/common.json';
import fr from '../../../messages/fr/common.json';
import { SponsorshipReport } from './sponsorship-report';
import { parseSponsorshipReport, REPORT_STATUSES } from '@/lib/tentaship-drops-report-types';

const LOCALES = { en, ar, es, fr } as const;
const U = { available: false, reason: 'NO_ALLOCATION_YET' };
const payload = (over: Record<string, unknown> = {}, metrics: Record<string, unknown> = {}) => ({
  sponsorshipId: 's1', status: 'available', kinds: {},
  metrics: { total: 10, available: 4, reserved: 2, allocated: 2, collected: 1, allocationsExpired: 1, reservationsCreated: 8, holdsReleased: 1, holdsExpired: 1, outstandingCollection: 2, collectionCompletionRate: 0.25, reconciled: true, ...metrics }, ...over,
});
const show = (locale: keyof typeof LOCALES, input: unknown) => render(
  <div dir={locale === 'ar' ? 'rtl' : 'ltr'} lang={locale}><NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ common: LOCALES[locale] }}><SponsorshipReport result={parseSponsorshipReport(input)} /></NextIntlClientProvider></div>,
);
const keys = (o: unknown, p = ''): string[] => (o && typeof o === 'object' ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p.slice(0, -1)]);

describe('TDP-04 sponsorship report (contained sponsor reporting foundation)', () => {
  it('has identical message keys in all four languages and a label for every sponsorship status', () => {
    const base = keys(en.tentashipDropsReport).sort();
    for (const l of ['ar', 'es', 'fr'] as const) expect(keys(LOCALES[l].tentashipDropsReport).sort(), l).toEqual(base);
    for (const l of ['en', 'ar', 'es', 'fr'] as const) for (const s of REPORT_STATUSES) expect((LOCALES[l].tentashipDropsReport.overview.status as Record<string, string>)[s], `${l}.${s}`).toBeTruthy();
  });
  it.each(['en', 'ar', 'es', 'fr'] as const)('renders recorded aggregates in %s, with no action, link, export, identity, revenue or acquisition figure', (l) => {
    const { container } = show(l, payload());
    expect(screen.getByTestId('m-total')).toHaveTextContent('10'); expect(screen.getByTestId('m-available')).toHaveTextContent('4'); expect(screen.getByTestId('m-created')).toHaveTextContent('8');
    expect(screen.getByTestId('m-outstanding')).toHaveTextContent('2'); expect(screen.getByTestId('m-completion').textContent).toMatch(/25/);
    expect(screen.queryAllByRole('button')).toHaveLength(0); expect(screen.queryAllByRole('link')).toHaveLength(0); expect(container.querySelector('a, button, form, input')).toBeNull();
    expect((container.textContent ?? '').replace(LOCALES[l].tentashipDropsReport.notice, '')).not.toMatch(/export|csv|download|exportar|télécharger|تصدير|revenue|profit|roas|lifetime|ingresos|rentabilidad|revenu|rendement|الإيرادات|الربح/i);
    expect(screen.getByTestId('m-reconciled')).not.toHaveAttribute('role', 'alert');
  });
  it('history is shown apart from current inventory and says it is not an inventory balance; expired uncollected units are not returned', () => {
    show('en', payload());
    const inv = screen.getByTestId('drops-inventory'); const act = screen.getByTestId('drops-activity');
    expect(within(inv).getByText(/not returned to the available inventory/)).toBeInTheDocument();
    expect(within(act).getByText(/not an additional inventory balance/)).toBeInTheDocument();
    expect(within(inv).queryByTestId('m-released')).toBeNull(); expect(within(act).getByTestId('m-released')).toBeInTheDocument();
  });
  it('NEVER shows an unavailable figure as zero: it says "Not available" with the reason; a suppressed small group hides every customer-derived figure', () => {
    show('en', payload({}, { collectionCompletionRate: U }));
    const c = screen.getByTestId('m-completion'); expect(c).toHaveAttribute('data-unavailable', 'true'); expect(c.textContent).toMatch(/Not available/); expect(c.textContent).toMatch(/No unit has been allocated yet/); expect(c.textContent).not.toMatch(/\b0\b|0%/);
  });
  it('a suppressed small group shows no customer-derived figure', () => {
    const hidden = { available: false, reason: 'SUPPRESSED_SMALL_GROUP' };
    show('fr', payload({}, { reserved: hidden, allocated: hidden, collected: hidden, available: hidden, reservationsCreated: hidden, holdsReleased: hidden, holdsExpired: hidden, outstandingCollection: hidden, collectionCompletionRate: hidden, allocationsExpired: hidden }));
    for (const id of ['m-reserved', 'm-allocated', 'm-collected', 'm-available', 'm-created', 'm-released', 'm-holds-expired', 'm-outstanding', 'm-completion', 'm-expired-unreturned']) { const el = screen.getByTestId(id); expect(el).toHaveAttribute('data-unavailable', 'true'); expect(el.textContent).toMatch(/Non disponible/); expect(el.textContent).not.toMatch(/\d/); }
    expect(screen.getByTestId('m-total')).toHaveTextContent('10'); // the sponsor's own supply is not customer-derived
  });
  it('a failed reconciliation is a visible alert that promises NO automatic correction', () => {
    show('en', payload({}, { reconciled: false }));
    const r = screen.getByTestId('m-reconciled'); expect(r).toHaveAttribute('role', 'alert'); expect(r.textContent).toMatch(/No automatic correction is made/);
  });
  it('Arabic renders in an RTL container with logical alignment and Arabic labels', () => {
    const { container } = show('ar', payload());
    expect(container.firstElementChild).toHaveAttribute('dir', 'rtl'); expect(container.innerHTML).toContain('text-start'); expect(container.innerHTML).not.toMatch(/\b(ml|mr|pl|pr|text-left|text-right)-/);
    expect(screen.getByTestId('drops-status')).toHaveTextContent('متاحة'); expect(screen.getByText('نظرة عامة على الرعاية')).toBeInTheDocument();
  });
  it('shows a no-inventory state for a draft sponsorship and an honest unavailable state for malformed data (never an invented success)', () => {
    const d = show('es', { sponsorshipId: 's2', status: 'draft', metrics: null, reason: 'NO_INVENTORY_UNTIL_APPROVED' });
    expect(screen.getByText('El inventario existe solo después de aprobar el patrocinio.')).toBeInTheDocument(); expect(screen.queryByTestId('m-total')).toBeNull(); d.unmount();
    for (const bad of [null, {}, payload({ status: 'released' }), payload({}, { total: -1 }), payload({}, { available: null }), payload({}, { reserved: '2' }), payload({}, { reconciled: 'yes' }), { status: 'available', metrics: null, reason: 'SOMETHING_ELSE' }]) {
      const { unmount } = show('en', bad); expect(screen.getByText('This report is not available right now.')).toBeInTheDocument(); expect(screen.queryByTestId('m-total')).toBeNull(); unmount();
    }
  });
  it('the parser accepts the documented API shape only and carries no identity or financial field', () => {
    const r = parseSponsorshipReport(payload({ businessId: 'b1', customerId: 'LEAK', revenue: 5 }));
    expect(r.state).toBe('ready'); expect(JSON.stringify(r)).not.toMatch(/LEAK|revenue|businessId/);
  });
});
