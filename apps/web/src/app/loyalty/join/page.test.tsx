import { createTranslator } from 'next-intl';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils';
import en from '../../../../messages/en/loyalty.json';
import es from '../../../../messages/es/loyalty.json';
import fr from '../../../../messages/fr/loyalty.json';
import ar from '../../../../messages/ar/loyalty.json';
import { publicApiFetch } from '@/lib/public-api-client';
import LoyaltyJoinPage from './page';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/public-api-client', () => ({ publicApiFetch: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: { loyalty: en }, namespace: namespace as never }),
}));

describe('/loyalty/join (LANDING-ROLE-01)', () => {
  beforeEach(() => {
    vi.mocked(publicApiFetch).mockReset();
  });

  it('explains the QR path and offers the registered businesses from the public list', async () => {
    vi.mocked(publicApiFetch).mockResolvedValue({ businesses: [{ name: 'Blue Cafe' }, { name: 'Zed Gym' }] });
    renderWithIntl(await LoyaltyJoinPage());
    expect(publicApiFetch).toHaveBeenCalledWith('/public/businesses');
    expect(screen.getByRole('heading', { name: 'Join as a loyalty customer' })).toBeInTheDocument();
    expect(screen.getByText('Scan a business QR code')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Join Echo Grid directly' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create my Echo Grid account' })).toHaveAttribute('href', '/loyalty/signup');
    expect(screen.getByRole('heading', { name: 'Search for a business to join' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search businesses' })).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a business…', 'Blue Cafe', 'Zed Gym']);
    expect(screen.getByRole('link', { name: 'Back to choose how to participate' })).toHaveAttribute('href', '/signup');
  });

  it('still shows the QR path when the list cannot be loaded', async () => {
    vi.mocked(publicApiFetch).mockRejectedValue(new Error('down'));
    renderWithIntl(await LoyaltyJoinPage());
    expect(screen.getByText('Scan a business QR code')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create my Echo Grid account' })).toHaveAttribute('href', '/loyalty/signup');
    expect(screen.getByText(/couldn't load the list/i)).toBeInTheDocument();
  });

  it('has every join-hub string in all four languages', () => {
    const hub = (m: unknown) => (m as { customer: { joinHub: Record<string, string> } }).customer.joinHub;
    const keys = Object.keys(hub(en)).sort();
    for (const locale of [es, fr, ar]) {
      expect(Object.keys(hub(locale)).sort()).toEqual(keys);
      for (const key of keys) expect(hub(locale)[key]!.trim().length).toBeGreaterThan(0);
      expect(hub(locale).chosenTitle).toContain('{name}');
      expect(hub(locale).chosenBody).toContain('{name}');
    }
  });
});
