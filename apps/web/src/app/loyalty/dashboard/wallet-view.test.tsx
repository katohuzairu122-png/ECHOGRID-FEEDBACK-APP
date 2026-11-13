import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import type { LoyaltyAccountDto } from '@echo-grid-feedback/shared-types';
import { LoyaltyWalletUnavailable, LoyaltyWalletView } from './wallet-view';

const account = (
  over: Partial<LoyaltyAccountDto> & { id: string; businessId: string },
): LoyaltyAccountDto => ({
  customerId: 'c1',
  points: 120,
  tierId: null,
  visitCount: 3,
  lastVisitAt: '2026-11-01T10:00:00.000Z',
  status: 'active',
  ...over,
});

describe('LoyaltyWalletView', () => {
  it('shows one linked card per business with its own points and never a combined total', () => {
    renderWithIntl(
      <LoyaltyWalletView
        entries={[
          {
            account: account({ id: 'a1', businessId: 'b1', points: 1200 }),
            businessName: 'Cafe One',
          },
          { account: account({ id: 'a2', businessId: 'b2', points: 80 }), businessName: 'Gym Two' },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'My loyalties' })).toBeInTheDocument();
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole('link')).toHaveAttribute('href', '/loyalty/dashboard/b1');
    expect(within(items[0]!).getByText('1,200 pts')).toBeInTheDocument();
    expect(within(items[1]!).getByText('80 pts')).toBeInTheDocument();
    expect(screen.queryByText('1,280 pts')).not.toBeInTheDocument();
    expect(screen.getByText('2 businesses')).toBeInTheDocument();
    expect(screen.getByText(/never combined/i)).toBeInTheDocument();
  });

  it('labels a paused membership and uses a neutral fallback for an unnamed business', () => {
    renderWithIntl(
      <LoyaltyWalletView
        entries={[
          {
            account: account({ id: 'a1', businessId: 'b1', status: 'suspended' }),
            businessName: null,
          },
        ]}
      />,
    );
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Business')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Business/ })).toBeInTheDocument();
  });

  it('explains how to join in the empty state, with no join action', () => {
    renderWithIntl(<LoyaltyWalletView entries={[]} />);
    expect(screen.getByText(/haven’t joined a loyalty program yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/scan the QR code a participating business shows/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('keeps the QR and settlements shortcuts, translated, and shows singular and never-visited text', () => {
    renderWithIntl(
      <LoyaltyWalletView
        entries={[
          {
            account: account({ id: 'a1', businessId: 'b1', visitCount: 1, lastVisitAt: null }),
            businessName: 'Solo',
          },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Show my customer QR' })).toHaveAttribute(
      'href',
      '/loyalty/dashboard/qr',
    );
    expect(screen.getByRole('link', { name: 'Orphan settlements' })).toHaveAttribute(
      'href',
      '/loyalty/dashboard/settlements',
    );
    expect(screen.getByText(/1 visit/)).toBeInTheDocument();
    expect(screen.getByText(/No visits yet/)).toBeInTheDocument();
    expect(screen.getByText('1 business')).toBeInTheDocument();
  });

  it('an unavailable wallet is an explicit retryable state, never an empty wallet', () => {
    renderWithIntl(<LoyaltyWalletUnavailable />);
    expect(screen.getByRole('status')).toHaveTextContent(/can’t load your loyalties right now/i);
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/loyalty/dashboard',
    );
    expect(screen.queryByText(/haven’t joined/i)).not.toBeInTheDocument();
  });

  it('marks only the business that has unread messages for this customer', () => {
    renderWithIntl(
      <LoyaltyWalletView
        entries={[
          { account: account({ id: 'a1', businessId: 'b1' }), businessName: 'Cafe One' },
          { account: account({ id: 'a2', businessId: 'b2' }), businessName: 'Gym Two' },
        ]}
        unreadByBusiness={{ b2: 2 }}
      />,
    );
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(within(items[0]!).queryByText(/new message/)).not.toBeInTheDocument();
    expect(within(items[1]!).getByText('2 new messages')).toBeInTheDocument();
  });
});
