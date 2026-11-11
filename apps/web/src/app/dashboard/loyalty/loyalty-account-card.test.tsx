import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LoyaltyAccountCard } from './loyalty-account-card';

const common = {
  customer: 'Customer A',
  visitLabel: '1 visit',
  lastVisitAt: '2026-11-10T08:30:00.000Z',
  lastVisitLabel: 'Last visit Nov 10',
  points: '45',
  pointsLabel: 'Business loyalty points',
  suspended: false,
  suspendedLabel: 'Suspended',
  actions: <button type="button">Manage</button>,
};

describe('LoyaltyAccountCard', () => {
  it('labels a real business-specific points balance, visits and timestamp without inventing a total', () => {
    render(<LoyaltyAccountCard {...common} />);
    const card = screen.getByRole('article', { name: 'Customer A' });
    expect(within(card).getByText('Business loyalty points')).toBeInTheDocument();
    expect(within(card).getByText('45')).toBeInTheDocument();
    expect(within(card).getByText(/1 visit/)).toBeInTheDocument();
    expect(within(card).getByText('Last visit Nov 10')).toHaveAttribute('dateTime', common.lastVisitAt);
    expect(within(card).getByRole('button', { name: 'Manage' })).toBeInTheDocument();
    expect(within(card).queryByText('Suspended')).not.toBeInTheDocument();
  });

  it('shows a status only when the provided account is suspended and never fabricates a last-visit timestamp', () => {
    render(
      <LoyaltyAccountCard
        {...common}
        suspended
        points="0"
        lastVisitAt={null}
        lastVisitLabel="No visits yet"
      />,
    );
    const card = screen.getByRole('article', { name: 'Customer A' });
    expect(within(card).getByText('Suspended')).toBeInTheDocument();
    expect(within(card).getByText('0')).toBeInTheDocument();
    expect(within(card).getByText('No visits yet')).toBeInTheDocument();
    expect(card.querySelector('time')).toBeNull();
  });
});
