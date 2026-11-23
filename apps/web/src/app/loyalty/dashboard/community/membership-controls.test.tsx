import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import { CommunityMembershipControls } from './membership-controls';
import type { CommunityTermsOffer } from '@echo-grid-feedback/shared-types';
const h = vi.hoisted(() => ({ leave: vi.fn(), join: vi.fn(), router: { refresh: vi.fn() } }));
vi.mock('@/lib/actions/community-membership', () => ({ leaveCommunityAction: h.leave, joinCommunityAction: h.join }));
vi.mock('next/navigation', () => ({ useRouter: () => h.router }));
beforeEach(() => { vi.clearAllMocks(); h.leave.mockResolvedValue({ left: true }); });
const offer: CommunityTermsOffer = { activationAvailable: true, operation: 'join', transitionId: null, terms: { publicationId: '22222222-2222-4222-8222-222222222222', version: 'synthetic-unit-only',
  effectiveAt: '2020-01-01T00:00:00Z', locale: 'en', content: 'SYNTHETIC TEST TERMS — NOT LEGAL APPROVAL', contentHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64), hashAlgorithm: 'sha256-utf8' } };
it('requires explicit unchecked acceptance, then refreshes authoritative membership and points', async () => {
  const user = userEvent.setup(); h.join.mockResolvedValue({ joined: true, released: 2 });
  renderWithIntl(<CommunityMembershipControls status="absent" phone="verified" offer={offer} />);
  const check = screen.getByRole('checkbox'); expect(check).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Join Community' })).toBeDisabled(); expect(h.join).not.toHaveBeenCalled();
  await user.click(check); await user.click(screen.getByRole('button', { name: 'Join Community' }));
  await waitFor(() => expect(h.join).toHaveBeenCalledTimes(1)); await waitFor(() => expect(h.router.refresh).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Join Community' })).toBeDisabled();
});
it('does not mistake phone verification for acceptance or membership', () => {
  renderWithIntl(<CommunityMembershipControls status="absent" phone="unverified" offer={offer} />);
  expect(screen.getByRole('checkbox')).toBeDisabled(); expect(screen.getByRole('button', { name: 'Join Community' })).toBeDisabled(); expect(h.join).not.toHaveBeenCalled();
});
it('keeps stale terms recoverable and requires refresh before another attempt', async () => {
  const user = userEvent.setup(); h.join.mockResolvedValue({ error: 'stale' });
  renderWithIntl(<CommunityMembershipControls status="absent" phone="verified" offer={offer} />);
  await user.click(screen.getByRole('checkbox')); await user.click(screen.getByRole('button', { name: 'Join Community' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Terms or membership changed');
  expect(screen.getByRole('button', { name: 'Join Community' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Refresh status' })); expect(h.router.refresh).toHaveBeenCalled();
});
it('distinguishes cleared inactive membership from voluntary Leave and allows explicit acceptance or confirmed Leave', () => {
  renderWithIntl(<CommunityMembershipControls status="inactive" phone="verified" offer={{ ...offer, operation: 'restore' }} />);
  expect(screen.getByText(/Moderation is cleared/)).toBeVisible(); expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Restore Community membership' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Leave Community' })).toBeEnabled();
});
it.each(['absent', 'left'] as const)('keeps %s enrollment unavailable without approved terms', (status) => {
  renderWithIntl(<CommunityMembershipControls status={status} phone="verified" />);
  expect(screen.getByRole('button', { name: status === 'left' ? 'Rejoin Community' : 'Join Community' })).toBeDisabled();
  expect(screen.getByText(/until approved Community membership terms/)).toBeVisible();
  expect(h.leave).not.toHaveBeenCalled();
});
it('offers an explicit safe verification handoff without enrolling or requesting SMS', () => {
  renderWithIntl(<CommunityMembershipControls status="absent" phone="unverified" />);
  expect(screen.getByRole('link', { name: 'Verify phone in your account' })).toHaveAttribute('href', '/loyalty/dashboard/phone?next=%2Floyalty%2Fdashboard%2Fcommunity');
  expect(screen.getByRole('link', { name: 'Account Settings' })).toHaveAttribute('href', '/loyalty/dashboard/settings');
  expect(h.leave).not.toHaveBeenCalled();
});
it('does not expose suspended self-reactivation or leave', () => {
  renderWithIntl(<CommunityMembershipControls status="suspended" phone="verified" />);
  expect(screen.getByText(/cannot reactivate or leave/)).toBeVisible();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('confirms deliberate leave and refreshes only after authoritative success', async () => {
  const user = userEvent.setup();
  renderWithIntl(<CommunityMembershipControls status="active" phone="verified" />);
  await user.click(screen.getByRole('button', { name: 'Leave Community' }));
  expect(screen.getByRole('dialog', { name: 'Leave the Community?' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm leave' })).toBeDisabled();
  expect(h.leave).not.toHaveBeenCalled();
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Confirm leave' }));
  await waitFor(() => expect(h.leave).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(h.router.refresh).toHaveBeenCalled());
});
it('cancel makes no membership mutation', async () => {
  const user = userEvent.setup();
  renderWithIntl(<CommunityMembershipControls status="active" phone="unverified" />);
  await user.click(screen.getByRole('button', { name: 'Leave Community' }));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(h.leave).not.toHaveBeenCalled();
});
it('keeps a failed leave recoverable without optimistic success', async () => {
  h.leave.mockResolvedValue({ error: 'suspended' });
  const user = userEvent.setup();
  renderWithIntl(<CommunityMembershipControls status="active" phone="verified" />);
  await user.click(screen.getByRole('button', { name: 'Leave Community' }));
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Confirm leave' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('suspended');
  expect(h.router.refresh).not.toHaveBeenCalled();
});
it('prevents duplicate submit and dismissal while authoritative leave is pending', async () => {
  let finish!: (value: { left: true }) => void;
  h.leave.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const user = userEvent.setup();
  renderWithIntl(<CommunityMembershipControls status="active" phone="verified" />);
  await user.click(screen.getByRole('button', { name: 'Leave Community' }));
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Confirm leave' }));
  expect(await screen.findByRole('button', { name: 'Leaving…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(h.leave).toHaveBeenCalledTimes(1);
  finish({ left: true });
  await waitFor(() => expect(h.router.refresh).toHaveBeenCalled());
});
it('never presents proposed Community terms or a legal acceptance checkbox as active enrollment', () => {
  renderWithIntl(<CommunityMembershipControls status="absent" phone="verified" />);
  expect(screen.getByRole('button', { name: 'Join Community' })).toBeDisabled();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByText('community-membership-v1.0')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /membership terms/i })).not.toBeInTheDocument();
  expect(h.leave).not.toHaveBeenCalled();
});

it.each(['absent', 'left', 'inactive'] as const)('closed %s enrollment keeps account access and permitted Leave, with no acceptance checkbox', (status) => {
  renderWithIntl(<CommunityMembershipControls status={status} phone="verified" offer={{ ...offer, activationAvailable: false }} />);
  expect(screen.getByText(/Community membership is temporarily unavailable/)).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: status === 'inactive' ? 'Restore Community membership' : status === 'left' ? 'Rejoin Community' : 'Join Community' })).toBeDisabled();
  if (status === 'inactive') expect(screen.getByRole('button', { name: 'Leave Community' })).toBeEnabled();
  expect(h.join).not.toHaveBeenCalled(); expect(h.leave).not.toHaveBeenCalled();
});
it('an older API offer without authoritative availability fails closed', () => {
  const { activationAvailable: _availability, ...older } = offer;
  renderWithIntl(<CommunityMembershipControls status="absent" phone="verified" offer={older} />);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Join Community' })).toBeDisabled();
});
