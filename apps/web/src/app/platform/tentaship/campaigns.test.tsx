import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { canViewTentaship, parseCampaigns } from './campaigns';
import { CampaignsView } from './campaigns-view';

const v = { version: 1, minParticipants: 10, maxCapacity: 100, termsVersion: 'draft-1', releaseState: 'not_released', entryAcceptanceDeadline: '2026-12-01T00:00:00Z' };
const c = { id: 'c1', key: 'synthetic_one', mode: 'limited', status: 'suspended', statusReason: 'investigating', versions: [v] };

describe('TSH-06 platform Shuffle console (read-only foundation)', () => {
  it('only a non-impersonating platform admin may view it', () => {
    expect(canViewTentaship({ platformRole: 'admin', impersonatedBy: null })).toBe(true);
    expect(canViewTentaship({ platformRole: 'admin', impersonatedBy: 'u' } as never)).toBe(false);
    expect(canViewTentaship({ platformRole: null, impersonatedBy: null } as never)).toBe(false);
    expect(canViewTentaship(null)).toBe(false);
  });
  it('shows recorded configuration and lifecycle with NO release, publish, invite, select or allocate control', () => {
    render(<CampaignsView campaigns={parseCampaigns([c])} />);
    expect(screen.getByTestId('status-synthetic_one')).toHaveTextContent('suspended');
    expect(screen.getByText(/minimum 10, capacity 100, terms draft-1, not released/)).toBeInTheDocument();
    expect(screen.getByTestId('no-release')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /release|publish|go live|select|allocate|invite/i })).not.toBeInTheDocument();
  });
  it('malformed data is "could not be loaded", never an empty success; an empty list is stated as such', () => {
    for (const bad of [null, {}, [{ ...c, mode: 'raffle' }], [{ ...c, versions: [{ ...v, minParticipants: '10' }] }], [{ ...c, status: 'released' }]]) {
      const { unmount } = render(<CampaignsView campaigns={parseCampaigns(bad)} />);
      expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded'); unmount();
    }
    render(<CampaignsView campaigns={parseCampaigns([])} />);
    expect(screen.getByText('No campaigns have been configured.')).toBeInTheDocument();
  });
});
