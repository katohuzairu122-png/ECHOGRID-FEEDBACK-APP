import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';

vi.mock('@/lib/actions/unified-qr', () => ({ staffUnifiedQrAction: vi.fn() }));
import { staffUnifiedQrAction } from '@/lib/actions/unified-qr';
import { StaffQrMenu } from './staff-qr-menu';

describe('StaffQrMenu (cashier Serve customers)', () => {
  it('keeps the cashier inside the QR flow: no link to administrative loyalty accounts', () => {
    const { container } = render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    expect(container.querySelector('a[href^="/dashboard/loyalty"]')).toBeNull();
    expect(container.querySelector('a[href="/dashboard"]')).toBeNull();
  });

  it('shows one always-visible scan field, focused and ready for a connected scanner', () => {
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    const field = screen.getByLabelText(/Find customer: scan, or enter phone number/i, {
      selector: 'input[name="token"]',
    });
    expect(field).toBeVisible();
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('autocomplete', 'off');
  });

  it('no longer hides the field behind a button or a collapsed section', () => {
    const { container } = render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    expect(screen.queryByRole('button', { name: 'Verify with QR token' })).toBeNull();
    expect(screen.queryByText('Enter the QR token manually')).toBeNull();
    expect(container.querySelector('details')).toBeNull();
  });

  it('replaces the previous content when a scanner types into a field that already holds a code', async () => {
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    const field = screen.getByLabelText(/Find customer/i, {
      selector: 'input[name="token"]',
    }) as HTMLInputElement;
    const user = userEvent.setup();
    await user.type(field, 'first');
    field.blur();
    field.focus();
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
  });

  it('offers scan and the scan field, with no photo upload', () => {
    const { container } = render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/upload a photo/i)).toBeNull();
    expect(screen.getByLabelText(/Find customer/i, { selector: 'input' })).toBeInTheDocument();
  });

  it('shows a phone-identified customer with a first name and masked number, and only the purchase form', async () => {
    vi.mocked(staffUnifiedQrAction).mockResolvedValue({
      businessId: 'business',
      purchaseRequestKey: 'key-123456',
      lookup: {
        lookupToken: 'lookup.token.value',
        displayName: 'Amina',
        phoneMasked: '+•••••••4567',
        membershipStatus: 'active',
        actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE', 'VALIDATE_PURCHASE', 'GRANT_LOYALTY_PROGRESS'],
      },
    });
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Find customer/i, { selector: 'input' }), '+15551234567{Enter}');
    expect(await screen.findByText('Amina')).toBeInTheDocument();
    expect(screen.getByText(/\+•••••••4567/)).toBeInTheDocument();
    expect(screen.getByText(/Identified by phone/)).toBeInTheDocument();
    expect(screen.getByLabelText('Purchase amount')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm verified purchase' })).toBeInTheDocument();
    // No redemption, no ids, no full number.
    expect(screen.queryByText(/Customer’s reward code/)).toBeNull();
    expect(screen.getByText(/needs the customer’s QR code/)).toBeInTheDocument();
    const card = screen.getByText('Amina').closest('.rounded-xl') as HTMLElement;
    expect(card.textContent).not.toContain('5551234567');
    expect(card.textContent).not.toContain('lookup.token.value');
  });

  it('offers no purchase for a membership that cannot take one', async () => {
    vi.mocked(staffUnifiedQrAction).mockResolvedValue({
      businessId: 'business',
      lookup: {
        lookupToken: 'lookup.token.value',
        displayName: 'Member',
        phoneMasked: '+•••••••4567',
        membershipStatus: 'active',
        actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE'],
      },
    });
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Find customer/i, { selector: 'input' }), '+15551234567{Enter}');
    expect(await screen.findByText(/Purchases are not available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm verified purchase' })).toBeNull();
  });
});
