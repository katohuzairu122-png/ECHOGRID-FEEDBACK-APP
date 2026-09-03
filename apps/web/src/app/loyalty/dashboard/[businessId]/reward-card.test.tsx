import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '@/test-utils';
import type { LoyaltyRewardDto } from '@echo-grid-feedback/shared-types';
import { RewardCard } from './reward-card';

// Same mocking approach as reward-row-actions.test.tsx -- RewardCard never
// needs redeemRewardAction to actually resolve for any assertion below (no
// test here drives a submit through to a result), only to exist so
// useActionState has a bound action to call.
vi.mock('@/lib/actions/loyalty-customer', () => ({
  redeemRewardAction: vi.fn(),
}));

const REWARD: LoyaltyRewardDto = {
  id: 'reward-1',
  businessId: 'business-1',
  branchId: null,
  name: 'Free coffee',
  description: 'A regular coffee, on us.',
  type: 'points',
  pointsCost: 100,
  rewardValue: null,
  status: 'active',
  startDate: null,
  expiryDate: null,
  maxRewardsPerDay: null,
  maxBudget: null,
  limitPer: null,
  limitPeriodDays: null,
  cooldownSeconds: null,
  // Continuing Development Block 6.9 (S6.4) fields -- no rule configured,
  // same "not part of this fixture's scenario" defaults as the sibling
  // limit fields above. See reward-form-dialog.test.tsx's DISCOUNT_REWARD
  // for the matching fixture (kept in sync per that file's own comment).
  minCommentLength: null,
  requireVisitVerification: false,
};

describe('RewardCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression guard for the existing customer-facing path -- Block 6.7.3
  // only added an opt-in readOnly prop; these three prove that path is
  // unchanged for the caller that never passes it
  // (loyalty/dashboard/[businessId]/page.tsx).

  it('shows an enabled Redeem button when the customer can afford the reward', () => {
    render(<RewardCard reward={REWARD} businessId="business-1" currentPoints={150} />);
    expect(screen.getByRole('button', { name: 'Redeem' })).toBeEnabled();
  });

  it('disables the button and says so when the customer cannot afford the reward', () => {
    render(<RewardCard reward={REWARD} businessId="business-1" currentPoints={50} />);
    expect(screen.getByRole('button', { name: 'Not enough points' })).toBeDisabled();
  });

  it('defaults currentPoints to 0 when the prop is omitted -- same "cannot afford" path as an explicit 0', () => {
    render(<RewardCard reward={REWARD} businessId="business-1" />);
    expect(screen.getByRole('button', { name: 'Not enough points' })).toBeDisabled();
  });

  // Continuing Development Block 6.7.3 (S6.3 campaign dashboard) -- the new
  // readOnly preview mode used by the staff dashboard.

  it('readOnly renders the reward info but no redemption button, even when affordable', () => {
    render(<RewardCard reward={REWARD} businessId="business-1" currentPoints={150} readOnly />);

    expect(screen.getByText('Free coffee')).toBeInTheDocument();
    expect(screen.getByText('100 pts')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('readOnly renders no button even when unaffordable -- readOnly wins over canAfford, it does not just disable', () => {
    render(<RewardCard reward={REWARD} businessId="business-1" currentPoints={0} readOnly />);

    expect(screen.queryByRole('button', { name: 'Not enough points' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
