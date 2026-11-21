import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import { CommunityMembershipControls } from './membership-controls';
const h = vi.hoisted(() => ({ leave: vi.fn(), router: { refresh: vi.fn() } }));
vi.mock('@/lib/actions/community-membership', () => ({ leaveCommunityAction: h.leave }));
vi.mock('next/navigation', () => ({ useRouter: () => h.router }));
beforeEach(() => { vi.clearAllMocks(); h.leave.mockResolvedValue({ left: true }); });
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
