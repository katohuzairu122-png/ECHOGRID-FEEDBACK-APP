import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LoyaltyCatalogCard } from './loyalty-catalog-card';

describe('LoyaltyCatalogCard', () => {
  it('presents only the supplied tier data and keeps edit/delete actions available', () => {
    render(
      <LoyaltyCatalogCard
        title="Silver"
        kind="tier"
        details={<><span>100+ pts</span><span>Member benefits</span></>}
        actions={<><button type="button">Edit</button><button type="button">Delete</button></>}
      />,
    );
    const item = screen.getByRole('article', { name: 'Silver' });
    expect(item).toHaveAttribute('data-catalog-kind', 'tier');
    expect(within(item).getByText('100+ pts')).toBeInTheDocument();
    expect(within(item).getByText('Member benefits')).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(within(item).queryByText(/balance/i)).not.toBeInTheDocument();
  });

  it('does not invent points cost for a non-points reward and preserves the status/action slots', () => {
    render(
      <LoyaltyCatalogCard
        title="Complimentary drink"
        kind="reward"
        status={<span>Paused</span>}
        details={<span>Valid at selected locations</span>}
        actions={<a href="/dashboard/loyalty/rewards/1">Dashboard</a>}
      />,
    );
    const item = screen.getByRole('article', { name: 'Complimentary drink' });
    expect(item).toHaveAttribute('data-catalog-kind', 'reward');
    expect(within(item).getByText('Paused')).toBeInTheDocument();
    expect(within(item).getByText('Valid at selected locations')).toBeInTheDocument();
    expect(within(item).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard/loyalty/rewards/1');
    expect(within(item).queryByText(/pts/)).not.toBeInTheDocument();
  });
});
