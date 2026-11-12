import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';

vi.mock('@/lib/actions/unified-qr', () => ({ staffUnifiedQrAction: vi.fn() }));
import { StaffQrMenu } from './staff-qr-menu';

describe('StaffQrMenu (cashier Serve customers)', () => {
  it('keeps the cashier inside the QR flow: no link to administrative loyalty accounts', () => {
    const { container } = render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    expect(container.querySelector('a[href^="/dashboard/loyalty"]')).toBeNull();
    expect(container.querySelector('a[href="/dashboard"]')).toBeNull();
  });

  it('labels the lookup accurately: a QR-token verification, not a name or phone search', async () => {
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    expect(screen.queryByText(/search customers/i)).toBeNull();
    const verify = screen.getByRole('button', { name: 'Verify with QR token' });
    await userEvent.setup().click(verify);
    expect(screen.getByLabelText(/QR token/i, { selector: 'input[name="token"]' })).toHaveFocus();
  });

  it('offers scan, photo upload and manual entry together', () => {
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    expect(
      screen.getByLabelText('Upload a photo of the QR code', { selector: 'input' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Enter the QR token manually')).toBeInTheDocument();
  });
});
