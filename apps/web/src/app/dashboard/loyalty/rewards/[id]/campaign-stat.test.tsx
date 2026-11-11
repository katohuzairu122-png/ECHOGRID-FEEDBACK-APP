import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CampaignStat } from './campaign-stat';

describe('CampaignStat', () => {
  it('renders authorized counts with a readable semantic metric label', () => {
    render(
      <dl>
        <CampaignStat label="Redeemed" value="12" tone="cyan" />
        <CampaignStat label="Outstanding" value="3" />
      </dl>,
    );
    const list = screen.getByRole('list');
    expect(within(list).getByText('Redeemed').tagName).toBe('DT');
    expect(within(list).getByText('12').tagName).toBe('DD');
    expect(within(list).getByText('Outstanding')).toBeInTheDocument();
    expect(within(list).getByText('3')).toBeInTheDocument();
  });

  it('preserves explicit unavailable-rate text instead of inventing a zero', () => {
    render(
      <dl>
        <CampaignStat
          label="Redemption rate"
          value="—"
          hint="No redemptions yet"
          tone="violet"
        />
      </dl>,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('No redemptions yet')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});
