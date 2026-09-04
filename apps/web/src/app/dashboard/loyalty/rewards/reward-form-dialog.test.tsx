import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import type { BranchDto, LoyaltyRewardDto } from '@echo-grid-feedback/shared-types';
import { RewardFormDialog } from './reward-form-dialog';
import { createRewardAction, updateRewardAction } from '@/lib/actions/loyalty';

// Continuing Development Block 6.8.6 -- same mocking approach as
// branch-form-dialog.test.tsx and reward-row-actions.test.tsx: Server
// Actions can't run against a real server inside jsdom, so they're mocked
// at the module boundary. Most tests below never need the mock to resolve
// (only to exist so useActionState has a bound action to call) -- they're
// testing this dialog's OWN conditional-rendering logic across Blocks
// 6.8.1-6.8.4, not a real create/update round trip.
vi.mock('@/lib/actions/loyalty', () => ({
  createRewardAction: vi.fn(),
  updateRewardAction: vi.fn(),
}));

// Same fixture shape as branch-form-dialog.test.tsx's sampleBranch.
const BRANCHES: BranchDto[] = [
  {
    id: 'branch-1',
    businessId: 'business-1',
    name: 'Downtown',
    slug: 'downtown',
    addressLine1: '123 Main St',
    addressLine2: null,
    city: 'Austin',
    stateProvince: 'TX',
    postalCode: '78701',
    countryCode: 'US',
    timezone: 'America/Chicago',
    latitude: null,
    longitude: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'branch-2',
    businessId: 'business-1',
    name: 'Uptown',
    slug: 'uptown',
    addressLine1: '456 Oak Ave',
    addressLine2: null,
    city: 'Austin',
    stateProvince: 'TX',
    postalCode: '78702',
    countryCode: 'US',
    timezone: 'America/Chicago',
    latitude: null,
    longitude: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

// Same fixture shape as reward-card.test.tsx's REWARD.
const DISCOUNT_REWARD: LoyaltyRewardDto = {
  id: 'reward-2',
  businessId: 'business-1',
  branchId: 'branch-1',
  name: '10% off',
  description: null,
  type: 'discount',
  pointsCost: null,
  rewardValue: '10.00',
  status: 'paused',
  startDate: null,
  expiryDate: null,
  maxRewardsPerDay: null,
  maxBudget: null,
  limitPer: 'period',
  limitPeriodDays: 30,
  cooldownSeconds: null,
  // Continuing Development Block 6.9 (S6.4) fields -- no rule configured,
  // same "not part of this fixture's scenario" defaults as the sibling
  // limit fields above. Kept in sync with reward-card.test.tsx's REWARD
  // per this fixture's own "Same fixture shape as..." comment.
  minCommentLength: null,
  requireVisitVerification: false,
};

// New fixture for Block 4/Block 5 (S6.4 minimum feedback requirements) --
// a full literal, same convention as DISCOUNT_REWARD above, not a spread:
// this file's existing fixtures are always fully spelled out, not derived
// from another one. type: 'points' rather than reusing DISCOUNT_REWARD's
// non-points shape -- minCommentLength/requireVisitVerification's own
// rendering doesn't depend on type at all, so keeping this fixture on the
// simpler points path avoids any incidental coupling to the type-driven
// pointsCost/rewardValue tests above.
const MIN_FEEDBACK_REWARD: LoyaltyRewardDto = {
  id: 'reward-3',
  businessId: 'business-1',
  branchId: null,
  name: 'Verified visit voucher',
  description: null,
  type: 'points',
  pointsCost: 50,
  rewardValue: null,
  status: 'active',
  startDate: null,
  expiryDate: null,
  maxRewardsPerDay: null,
  maxBudget: null,
  limitPer: null,
  limitPeriodDays: null,
  cooldownSeconds: null,
  minCommentLength: 25,
  requireVisitVerification: true,
};

describe('RewardFormDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Block 6.8.1 -- type drives pointsCost/rewardValue.

  it('create mode: defaults to points type, showing pointsCost and not rewardValue', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));

    expect(screen.getByLabelText('Points cost')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reward value')).not.toBeInTheDocument();
  });

  it('switching type away from points hides pointsCost and shows rewardValue', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));

    await user.selectOptions(screen.getByLabelText('Reward type'), 'discount');

    expect(screen.queryByLabelText('Points cost')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Reward value')).toBeInTheDocument();
  });

  it('switching back to points restores pointsCost and hides rewardValue', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));

    await user.selectOptions(screen.getByLabelText('Reward type'), 'voucher');
    await user.selectOptions(screen.getByLabelText('Reward type'), 'points');

    expect(screen.getByLabelText('Points cost')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reward value')).not.toBeInTheDocument();
  });

  it('edit mode: a non-points reward shows rewardValue pre-filled, not pointsCost', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog reward={DISCOUNT_REWARD} branches={BRANCHES} trigger={<button>Edit</button>} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.queryByLabelText('Points cost')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Reward value')).toHaveValue(10);
  });

  // Block 6.8.1 -- branch scope.

  it('branch select lists every provided branch plus "All branches", defaulting to the reward\'s own branch', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog reward={DISCOUNT_REWARD} branches={BRANCHES} trigger={<button>Edit</button>} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('option', { name: 'All branches' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Downtown' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Uptown' })).toBeInTheDocument();
    expect(screen.getByLabelText('Branch')).toHaveValue('branch-1');
  });

  // Block 6.8.2 -- edit-only status.

  it('status select is absent when creating and present, pre-filled, when editing', async () => {
    const user = userEvent.setup();
    const createRender = renderWithIntl(
      <RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />,
    );
    await user.click(screen.getByRole('button', { name: '+ New reward' }));
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    createRender.unmount();

    renderWithIntl(<RewardFormDialog reward={DISCOUNT_REWARD} branches={BRANCHES} trigger={<button>Edit</button>} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Status')).toHaveValue('paused');
  });

  // Block 6.8.3 -- limitPer drives limitPeriodDays.

  it('limitPeriodDays is hidden until limitPer is set to "Once per period"', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));

    expect(screen.queryByLabelText('Period length (days)')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Redemption limit'), 'period');
    expect(screen.getByLabelText('Period length (days)')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Redemption limit'), 'visit');
    expect(screen.queryByLabelText('Period length (days)')).not.toBeInTheDocument();
  });

  it('edit mode: a period-limited reward shows limitPeriodDays pre-filled immediately', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog reward={DISCOUNT_REWARD} branches={BRANCHES} trigger={<button>Edit</button>} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Period length (days)')).toHaveValue(30);
  });

  // Block 6.8.5 -- the enforcement hint is programmatically associated,
  // not just visually adjacent.

  it('associates the limitPer enforcement hint with the select via aria-describedby', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));

    const select = screen.getByLabelText('Redemption limit');
    const describedById = select.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    // Continuing Development Block 4 of the S6.4 roadmap -- the hint text
    // itself changed (Block 3 of the same roadmap started enforcing
    // limitPer='visit' too, so the old "only the period limit is enforced"
    // wording became inaccurate; see en/loyalty.json's limitPerEnforcementHint).
    // Loosened from the old exact-wording regex to /enforced today/i: this
    // test's own job (per the comment above) is confirming the hint text is
    // programmatically associated via aria-describedby, not pinning the
    // precise enforcement wording -- a tighter regex would just repeat the
    // same brittleness that broke here once 'visit' joined 'period' as
    // enforced.
    expect(document.getElementById(describedById as string)).toHaveTextContent(/enforced today/i);
  });

  // Block 6.8.4 -- startDate/expiryDate cross-constrain via HTML min/max.
  // fireEvent.change, not user.type: <input type="date"> doesn't reliably
  // accept simulated keystrokes in jsdom (a well-documented testing-library
  // limitation for segmented date inputs) -- fireEvent sets the value and
  // fires the same change event React's controlled onChange listens for,
  // without going through per-character key simulation.

  it('setting a start date constrains the expiry date input\'s min to that date', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));

    const expiryInput = screen.getByLabelText('Expiry date');
    expect(expiryInput).not.toHaveAttribute('min');

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-06-01' } });
    expect(expiryInput).toHaveAttribute('min', '2026-06-01');
  });

  it('setting an expiry date constrains the start date input\'s max to that date', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));

    const startInput = screen.getByLabelText('Start date');
    expect(startInput).not.toHaveAttribute('max');

    fireEvent.change(screen.getByLabelText('Expiry date'), { target: { value: '2026-09-30' } });
    expect(startInput).toHaveAttribute('max', '2026-09-30');
  });

  // Continuing Development Block 5 of the S6.4 roadmap (test coverage for
  // Block 4) -- minCommentLength and requireVisitVerification, added to
  // this dialog in Block 4. Both always render (unlike pointsCost/
  // rewardValue/limitPeriodDays/status above, which are conditional), so
  // these check default-vs-pre-filled VALUE, not presence/absence.

  it('create mode: minCommentLength has no forced value, and requireVisitVerification defaults to unchecked', async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));

    // Direct .value check, not toHaveValue(null) -- unambiguous for an
    // empty number input regardless of the exact jest-dom matcher
    // semantics for that case.
    expect((screen.getByLabelText('Minimum comment length') as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Require visit verification')).not.toBeChecked();
  });

  it('edit mode: minCommentLength and requireVisitVerification are both pre-filled from the reward', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <RewardFormDialog reward={MIN_FEEDBACK_REWARD} branches={BRANCHES} trigger={<button>Edit</button>} />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // toHaveValue(<number>) on a numeric input -- same matcher shape already
    // proven in this file (Reward value/Period length above), not a new
    // pattern.
    expect(screen.getByLabelText('Minimum comment length')).toHaveValue(25);
    expect(screen.getByLabelText('Require visit verification')).toBeChecked();
  });

  it("associates the minCommentLength hint with the input via aria-describedby -- same pattern Block 6.8.5 established for limitPer's hint", async () => {
    const user = userEvent.setup();
    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));

    const input = screen.getByLabelText('Minimum comment length');
    const describedById = input.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById as string)).toHaveTextContent(/anonymously/i);
  });

  // Regression guard: five blocks of new fields layered onto this dialog
  // since it only had name/description/pointsCost -- confirm create/edit
  // mode still wire to the right action and only that action.

  it('create mode calls createRewardAction, not updateRewardAction', async () => {
    const user = userEvent.setup();
    vi.mocked(createRewardAction).mockResolvedValue({ success: true });

    renderWithIntl(<RewardFormDialog branches={BRANCHES} trigger={<button>+ New reward</button>} />);
    await user.click(screen.getByRole('button', { name: '+ New reward' }));
    await user.type(screen.getByLabelText('Name'), 'Free pastry');
    await user.type(screen.getByLabelText('Points cost'), '50');
    await user.click(screen.getByRole('button', { name: 'Create reward' }));

    await waitFor(() => expect(createRewardAction).toHaveBeenCalled());
    expect(updateRewardAction).not.toHaveBeenCalled();
  });

  it('edit mode calls updateRewardAction, not createRewardAction', async () => {
    const user = userEvent.setup();
    vi.mocked(updateRewardAction).mockResolvedValue({ success: true });

    renderWithIntl(<RewardFormDialog reward={DISCOUNT_REWARD} branches={BRANCHES} trigger={<button>Edit</button>} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateRewardAction).toHaveBeenCalled());
    expect(createRewardAction).not.toHaveBeenCalled();
  });
});
