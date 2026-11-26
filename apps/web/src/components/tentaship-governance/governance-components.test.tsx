import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../../messages/en/common.json';
import ar from '../../../messages/ar/common.json';
import es from '../../../messages/es/common.json';
import fr from '../../../messages/fr/common.json';
import { SponsorApplicationStatus } from './sponsor-application-status';
import { GovernanceCaseSummary } from './governance-case-summary';
import { parseGovernanceCase, parseSponsorApplication } from '@/lib/tentaship-governance-types';

const LOCALES = { en, ar, es, fr } as const;
const sponsor = { status: 'suspended', reason: 'Recorded synthetic reason.', changedAt: '2026-11-26T08:00:00.000Z' };
const govCase = { kind: 'fraud', status: 'decided', decision: 'upheld', evidenceCount: 2, policyVersion: 3, chain: 'ok' };
const wrap = (l: keyof typeof LOCALES, body: React.ReactNode) => render(<div dir={l === 'ar' ? 'rtl' : 'ltr'} lang={l}><NextIntlClientProvider locale={l} timeZone="UTC" messages={{ common: LOCALES[l] }}>{body}</NextIntlClientProvider></div>);
const keys = (o: unknown, p = ''): string[] => (o && typeof o === 'object' ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p.slice(0, -1)]);

describe('G3 contained sponsor-application and governance-case components', () => {
  it('have identical message keys in all four languages', () => {
    for (const ns of ['tentashipSponsorApplication', 'tentashipGovernance'] as const) { const base = keys(en[ns]).sort(); for (const l of ['ar', 'es', 'fr'] as const) expect(keys(LOCALES[l][ns]).sort(), `${ns} ${l}`).toEqual(base); }
  });
  it('parsers accept only the documented shape; anything else is unavailable (never an invented success)', () => {
    expect(parseSponsorApplication(sponsor).state).toBe('ready');
    for (const bad of [null, [], {}, { ...sponsor, status: 'approved_by_me' }, { ...sponsor, changedAt: 'yesterday' }, { ...sponsor, reason: 5 }]) expect(parseSponsorApplication(bad).state).toBe('unavailable');
    expect(parseGovernanceCase(govCase).state).toBe('ready');
    for (const bad of [null, {}, { ...govCase, kind: 'x' }, { ...govCase, evidenceCount: -1 }, { ...govCase, policyVersion: 0 }, { ...govCase, chain: 'fine' }, { ...govCase, decision: 'guilty' }]) expect(parseGovernanceCase(bad).state).toBe('unavailable');
  });
  it.each(['en', 'ar', 'es', 'fr'] as const)('render recorded values only, in %s, with no controls and no identity', (l) => {
    const { container } = wrap(l, <><SponsorApplicationStatus result={parseSponsorApplication(sponsor)} /><GovernanceCaseSummary result={parseGovernanceCase(govCase)} /></>);
    expect(screen.getByTestId('sponsor-status')).toBeInTheDocument(); expect(screen.getByTestId('sponsor-reason')).toHaveTextContent('Recorded synthetic reason.');
    expect(screen.getByTestId('case-decision')).toBeInTheDocument(); expect(screen.getByTestId('case-evidence')).toHaveTextContent('2');
    expect(screen.queryAllByRole('button')).toHaveLength(0); expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/\b(ml|mr|pl|pr|text-left|text-right)-/);
  });
  it('a failed evidence-log verification is an alert; an unrecorded decision/policy and unavailable data are explicit, never blank or zero', () => {
    wrap('en', <GovernanceCaseSummary result={parseGovernanceCase({ ...govCase, decision: null, policyVersion: null, chain: 'broken', status: 'open' })} />);
    expect(screen.getByTestId('case-chain')).toHaveAttribute('role', 'alert'); expect(screen.getByTestId('case-decision')).toHaveTextContent('No decision recorded.'); expect(screen.getByTestId('case-policy')).toHaveTextContent('No policy recorded.');
  });
  it('unavailable renders a status message, not data', () => {
    wrap('fr', <SponsorApplicationStatus result={parseSponsorApplication(null)} />);
    expect(screen.getByRole('status')).toHaveTextContent(fr.tentashipSponsorApplication.unavailable);
  });
});
