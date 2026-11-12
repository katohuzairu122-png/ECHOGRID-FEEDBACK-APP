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

  it('shows one always-visible scan field, focused and ready for a connected scanner', () => {
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    const field = screen.getByLabelText(/Customer QR code \(scanner or paste\)/i, {
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
    const field = screen.getByLabelText(/Customer QR code/i, {
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
    expect(screen.getByLabelText(/Customer QR code/i, { selector: 'input' })).toBeInTheDocument();
  });
});
