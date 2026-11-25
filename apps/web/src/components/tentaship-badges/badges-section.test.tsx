import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import { BadgesSection } from './badges-section';
import { badgeText, parseBadges } from '@/lib/tentaship-badges-types';

const badge = { awardId: 'a1', definitionKey: 'surveyor', version: 1, names: { en: 'Surveyor', ar: 'مستطلع' }, descriptions: { en: 'Completed 2 surveys.' }, awardedAt: '2026-11-25T10:00:00Z' };

describe('Tentaship Badges section', () => {
  it('lists badges, says they are not currency, and shows no value, balance or transfer control', () => {
    renderWithIntl(<BadgesSection badges={[badge]} evaluate={vi.fn()} />);
    expect(screen.getByText('Surveyor')).toBeInTheDocument();
    expect(screen.getByText(/not points, have no cash or other value/)).toBeInTheDocument();
    expect(screen.queryByText(/balance|redeem now|transfer to|cash out/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /redeem|transfer|buy|enter/i })).not.toBeInTheDocument();
  });
  it('shows an honest empty state', () => {
    renderWithIntl(<BadgesSection badges={[]} evaluate={vi.fn()} />);
    expect(screen.getByText('No badges yet.')).toBeInTheDocument();
  });
  it('the check button asks the server and reports the outcome', async () => {
    const evaluate = vi.fn().mockResolvedValue({ status: 'done', awarded: 1 });
    renderWithIntl(<BadgesSection badges={[]} evaluate={evaluate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for new badges' }));
    await waitFor(() => expect(screen.getByText('You earned a new badge.')).toBeInTheDocument());
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  it('a failed check says nothing changed', async () => {
    renderWithIntl(<BadgesSection badges={[]} evaluate={vi.fn().mockResolvedValue({ status: 'failed' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for new badges' }));
    await waitFor(() => expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument());
  });
});

describe('badge DTO parsing', () => {
  it('accepts the documented shape and falls back to English', () => {
    const r = parseBadges({ badges: [badge] });
    expect(r.state).toBe('ready');
    expect(badgeText(badge.names, 'ar')).toBe('مستطلع');
    expect(badgeText(badge.names, 'fr')).toBe('Surveyor');
  });
  it.each([null, {}, { badges: 'x' }, { badges: [{ awardId: 1 }] }, { badges: [{ ...badge, names: { en: 1 } }] }])('anything else is unavailable (%j)', (raw) => {
    expect(parseBadges(raw)).toEqual({ state: 'unavailable' });
  });
});
