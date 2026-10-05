import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BranchProgramDto } from '@echo-grid-feedback/shared-types';
import { BranchPanel } from './branch-panel';
vi.mock('@/lib/actions/branch-loyalty', () => ({ branchCustomerAction: vi.fn(async () => ({})) }));
vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="membership-qr">{value}</div>,
}));
const program: BranchProgramDto = {
  branchId: 'branch',
  businessId: 'business',
  onboardingMode: 'business_only',
  listedInCommunity: true,
  qualifyingPurchaseDescription: 'Paid coffee only',
  unitLabel: 'stamps',
  rewardName: 'Free coffee',
  rewardCost: 4,
  feedbackBonusUnits: 0,
  enabled: true,
};
describe('branch purchase onboarding', () => {
  it('signed-out customers use phone signup and return to the scanned QR', () => {
    render(
      <BranchPanel
        token="signed-qr"
        program={program}
        businessName="Coffee shop"
        branchName="First"
        signedIn={false}
      />,
    );
    expect(screen.getByRole('link', { name: /with your phone/ })).toHaveAttribute(
      'href',
      '/loyalty/login?next=%2Floyalty%2Fsigned-qr',
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
  it('business-only customers have an unchecked optional community choice', () => {
    render(
      <BranchPanel
        token="qr"
        program={program}
        businessName="Coffee shop"
        branchName="First"
        signedIn
      />,
    );
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('checkbox')).not.toBeRequired();
  });
  it('community-connected enrollment requires an unchecked explicit acceptance', () => {
    render(
      <BranchPanel
        token="qr"
        program={{ ...program, onboardingMode: 'community' }}
        businessName="Coffee shop"
        branchName="First"
        signedIn
      />,
    );
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('checkbox')).toBeRequired();
  });
  it('a pending account displays membership QR without claiming activation or points', () => {
    render(
      <BranchPanel
        token="qr"
        program={program}
        businessName="Coffee shop"
        branchName="First"
        signedIn
        membership={{
          id: 'membership',
          businessId: 'business',
          branchId: 'branch',
          businessName: 'Coffee shop',
          branchName: 'First',
          units: 0,
          activatedAt: null,
          enabled: true,
          unitLabel: 'stamps',
          rewardName: 'Free coffee',
          rewardCost: 4,
        }}
      />,
    );
    expect(screen.getByTestId('membership-qr')).toHaveTextContent('membership');
    expect(screen.getByText('Awaiting your first qualifying purchase')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enrollment/ })).not.toBeInTheDocument();
  });
});
