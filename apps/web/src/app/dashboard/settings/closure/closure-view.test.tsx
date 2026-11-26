import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';

const m = vi.hoisted(() => ({ reauth: vi.fn(), file: vi.fn(), withdraw: vi.fn() }));
vi.mock('@/lib/actions/business-closure', () => ({
  closureReauthAction: m.reauth, fileClosureRequestAction: m.file, withdrawClosureRequestAction: m.withdraw,
}));

import { ClosureView } from './closure-view';
import type { BusinessClosureStatusDto } from '@/lib/business-closure-types';

const obligations = { pendingRedemptions: 0, customerPointBalances: 1, customerPointsOutstanding: 120, activeMemberships: 3, openOrphanRewardClaims: 0, activeSubscriptions: 1, activeCashierSessions: 0, staffMembers: 2, publishedCommunityPosts: 0, communityFollowers: 5, activeSponsorships: 0, unitsAwaitingCollection: 0, openGovernanceCases: 0 };
const status = (over: Partial<BusinessClosureStatusDto> = {}): BusinessClosureStatusDto => ({
  request: null, eligibility: { processing: 'blocked', blockers: ['CLOSURE_POLICY_NOT_APPROVED', 'CUSTOMER_POINTS_OUTSTANDING', 'ACTIVE_SUBSCRIPTION'], obligations }, ...over,
});

beforeEach(() => { for (const fn of Object.values(m)) fn.mockReset(); });

describe('business closure view', () => {
  it('always shows the controlled blocked state with each blocker and the obligation counts', () => {
    renderWithIntl(<ClosureView businessName="Echo Cafe" status={status()} />);
    expect(screen.getByRole('heading', { name: 'Closure cannot be processed yet' })).toBeInTheDocument();
    expect(screen.getByText('The closure, settlement and record-retention rules are not approved yet.')).toBeInTheDocument();
    expect(screen.getByText('Customers still hold loyalty points with this business.')).toBeInTheDocument();
    expect(screen.getByText('Points held by customers').nextElementSibling).toHaveTextContent('120');
  });

  it('with no request: asks to confirm the password and to type the business name; offers no withdraw', () => {
    renderWithIntl(<ClosureView businessName="Echo Cafe" status={status()} />);
    expect(screen.getByLabelText('Your password')).toBeInTheDocument();
    expect(screen.getByLabelText('Type "Echo Cafe" to confirm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request closure' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw request' })).not.toBeInTheDocument();
  });

  it('with a pending request: says nothing was deleted, offers withdrawal, and does not offer a second request', () => {
    renderWithIntl(<ClosureView businessName="Echo Cafe" status={status({ request: { id: 'r1', status: 'pending', requestedAt: '2026-11-25T10:00:00Z', cancelledAt: null } })} />);
    expect(screen.getByText(/Nothing has been deleted or changed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request closure' })).not.toBeInTheDocument();
  });

  it('exposes no way to process, approve or complete a closure', () => {
    renderWithIntl(<ClosureView businessName="Echo Cafe" status={status()} />);
    expect(screen.queryByRole('button', { name: /process|approve|complete|delete|close now/i })).not.toBeInTheDocument();
  });
});
