import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithIntl as render } from '@/test-utils';
import type { PurchaseDto, ReversalPreviewDto } from '@/lib/loyalty-purchases';

vi.mock('@/lib/actions/loyalty-purchases', () => ({ reversePurchaseAction: vi.fn() }));
import { PurchasesTable } from './purchases-table';
import { ReversalPanel } from './reversal-panel';

const ID = '6f0f1c5e-0000-4000-8000-000000000004';
const confirmed: PurchaseDto = { id: ID, accountId: 'a', customerName: 'Amina K', occurredAt: '2026-06-10T12:00:00.000Z', channel: 'branch', amount: '12.500', status: 'confirmed', pointsEarned: 12, reversal: null };
const reversed: PurchaseDto = { ...confirmed, id: 'r', status: 'reversed', reversal: { reversedAt: '2026-06-11T12:00:00.000Z', pointsReversed: 5, pointsShortfall: 7 } };
const preview: ReversalPreviewDto = { purchaseEventId: ID, pointsEarned: 12, pointsReversed: 5, pointsShortfall: 7, rewardImpact: [{ rewardName: 'Free coffee', outcome: 'revoked' }, { rewardName: 'Free cake', outcome: 'already_used' }], frozenProgrammes: 0, needsReview: true };

describe('PurchasesTable (LPC-10)', () => {
  it('shows the exact amount text with the currency, the status and the right action per purchase', () => {
    render(<PurchasesTable items={[confirmed, reversed]} currency="KWD" />);
    expect(screen.getAllByText('12.500 KWD')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', `/dashboard/loyalty/purchases/${ID}`);
    expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute('href', '/dashboard/loyalty/purchases/r');
    expect(screen.getByText('Reversed')).toBeInTheDocument();
  });
  it('says so when there is nothing to show', () => {
    render(<PurchasesTable items={[]} currency="KWD" />);
    expect(screen.getByTestId('purchases-empty')).toBeInTheDocument();
  });
});

describe('ReversalPanel (LPC-10)', () => {
  it('shows the original purchase, the exact impact (including shortfall and a used reward warning), a mandatory reason and an explicit confirmation', () => {
    render(<ReversalPanel purchase={confirmed} currency="KWD" preview={preview} />);
    expect(screen.getByTestId('purchase-detail')).toHaveTextContent('12.500 KWD');
    const impact = screen.getByTestId('reversal-preview');
    expect(impact).toHaveTextContent('Take back 5 points');
    expect(impact).toHaveTextContent('7 points cannot be taken back');
    expect(screen.getByTestId('impact-revoked')).toHaveTextContent('Free coffee');
    expect(screen.getByTestId('impact-already_used')).toHaveTextContent('flagged for review');
    expect(screen.getByLabelText(/Reason \(required\)/)).toBeRequired();
    expect(screen.getByRole('checkbox')).toBeRequired();
    expect(screen.getByRole('button', { name: 'Reverse purchase' })).toBeEnabled();
  });
  it('cannot be submitted when the impact could not be calculated', () => {
    render(<ReversalPanel purchase={confirmed} currency="KWD" preview={null} previewError="UNAVAILABLE" />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be calculated');
    expect(screen.getByRole('button', { name: 'Reverse purchase' })).toBeDisabled();
  });
  it('shows the recorded outcome instead of a form for a purchase that was already reversed, so a duplicate cannot be submitted', () => {
    render(<ReversalPanel purchase={reversed} currency="KWD" preview={null} />);
    expect(screen.getByTestId('already-reversed')).toHaveTextContent('cannot be repeated');
    expect(screen.getByTestId('already-reversed')).toHaveTextContent('7 points could not be taken back');
    expect(screen.queryByTestId('reversal-form')).toBeNull();
  });
  it('treats a duplicate reported by the preview the same way', () => {
    render(<ReversalPanel purchase={confirmed} currency="KWD" preview={null} previewError="ALREADY_REVERSED" />);
    expect(screen.queryByTestId('reversal-form')).toBeNull();
  });
});
