import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';

vi.mock('@/lib/actions/unified-qr', () => ({ staffUnifiedQrAction: vi.fn() }));
vi.mock('@/lib/qr-decode', () => ({ readPixels: vi.fn(), decodeImageData: vi.fn() }));
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

  it('lists earned programme rewards and submits one hand-over for the chosen reward', async () => {
    const serveAction = vi.fn<typeof staffUnifiedQrAction>().mockResolvedValueOnce({
      businessId: 'business',
      branchId: '',
      token: 'signed.customer.qr',
      result: {
        customerId: 'customer',
        loyaltyAccountId: 'account',
        membershipStatus: 'active',
        actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE', 'REDEEM_REWARD'],
        card: {
          displayName: 'Amina', points: 0, tier: null, visitCount: 3, lastVisitAt: null, rewards: [],
          earnedRewards: [{ id: '6f0f1c5e-0000-4000-8000-000000000003', name: 'Free coffee', expiresAt: null }],
        },
      },
    }).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} serveAction={serveAction} />);
    await user.type(screen.getByLabelText(/Find customer/i, { selector: 'input[name="token"]' }), 'signed.customer.qr');
    await user.click(screen.getByRole('button', { name: 'Find customer' }));
    const section = await screen.findByTestId('earned-rewards');
    expect(section).toHaveTextContent('Free coffee');
    await user.click(screen.getByTestId('hand-over'));
    const form = serveAction.mock.calls.at(-1)![1];
    expect(form.get('operation')).toBe('redeem-entitlement');
    expect(form.get('entitlementId')).toBe('6f0f1c5e-0000-4000-8000-000000000003');
    expect(form.get('token')).toBe('signed.customer.qr');
  });

  it('shows no earned-rewards section when the member has none or the cashier may not redeem', async () => {
    const result = { customerId: 'c', loyaltyAccountId: 'a', membershipStatus: 'active' as const };
    const card = { displayName: 'Amina', points: 0, tier: null, visitCount: 1, lastVisitAt: null, rewards: [], earnedRewards: [] };
    const serveAction = vi.fn<typeof staffUnifiedQrAction>().mockResolvedValue({
      businessId: 'business', branchId: '', token: 't', result: { ...result, actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE', 'REDEEM_REWARD'], card },
    });
    const user = userEvent.setup();
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} serveAction={serveAction} />);
    await user.type(screen.getByLabelText(/Find customer/i, { selector: 'input[name="token"]' }), 't');
    await user.click(screen.getByRole('button', { name: 'Find customer' }));
    await screen.findByTestId('customer-card');
    expect(screen.queryByTestId('earned-rewards')).toBeNull();
  });

  it('offers scan and the scan field, with no photo upload', () => {
    const { container } = render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/upload a photo/i)).toBeNull();
    expect(screen.getByLabelText(/Find customer/i, { selector: 'input' })).toBeInTheDocument();
  });

  it('submits a camera scan and verified-phone search to the same branch-scoped counter action', async () => {
    const serveAction = vi.fn<typeof staffUnifiedQrAction>().mockResolvedValueOnce({
      businessId: 'business',
      branchId: 'branch-7',
      result: {
        customerId: 'customer',
        loyaltyAccountId: 'account',
        membershipStatus: 'active',
        actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE'],
      },
    }).mockResolvedValueOnce({
      businessId: 'business',
      branchId: 'branch-7',
      lookup: {
        lookupToken: 'lookup.token.value',
        displayName: 'Amina',
        phoneMasked: '+•••••••4567',
        phoneVerified: true,
        membershipStatus: 'active',
        actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE'],
      },
    });
    const media = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const stop = vi.fn();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const ready = vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
    vi.stubGlobal('BarcodeDetector', class {
      async detect() {
        return [{ rawValue: 'signed.customer.qr' }];
      }
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
      configurable: true,
    });
    const location = window.location.href;
    const user = userEvent.setup();
    try {
      render(
        <StaffQrMenu
          contexts={[{ branchId: 'branch-7', branchName: 'Main street' }]}
          serveAction={serveAction}
        />,
      );
      await user.click(screen.getByRole('button', { name: 'Scan' }));
      expect(await screen.findByText('Membership in this business: active')).toBeVisible();
      expect(stop).toHaveBeenCalledTimes(1);
      const field = screen.getByLabelText(/Find customer/i, { selector: 'input' });
      await user.clear(field);
      await user.type(field, '+15551234567{Enter}');
      expect(await screen.findByText('Amina')).toBeVisible();
      expect(serveAction.mock.calls.map(([, form]) => Object.fromEntries(form))).toEqual([
        { operation: 'resolve', token: 'signed.customer.qr', branchId: 'branch-7' },
        { operation: 'resolve', token: '+15551234567', branchId: 'branch-7' },
      ]);
      expect(window.location.href).toBe(location);
      expect(screen.queryByRole('button', { name: 'Confirm verified purchase' })).toBeNull();
    } finally {
      play.mockRestore();
      ready.mockRestore();
      vi.unstubAllGlobals();
      if (media) Object.defineProperty(navigator, 'mediaDevices', media);
      else Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  });

  it('shows a phone-identified customer with a first name and masked number, and only the purchase form', async () => {
    vi.mocked(staffUnifiedQrAction).mockResolvedValue({
      businessId: 'business',
      purchaseRequestKey: 'key-123456',
      lookup: {
        lookupToken: 'lookup.token.value',
        displayName: 'Amina',
        phoneMasked: '+•••••••4567',
        phoneVerified: true,
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

  it('warns the cashier to confirm the name when the customer’s phone was never verified (and not when it was)', async () => {
    const result = (phoneVerified: boolean) => ({
      businessId: 'business',
      purchaseRequestKey: 'key-123456',
      lookup: {
        lookupToken: 'lookup.token.value',
        displayName: 'Amina',
        phoneMasked: '+•••••••4567',
        phoneVerified,
        membershipStatus: 'active' as const,
        actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE', 'VALIDATE_PURCHASE', 'GRANT_LOYALTY_PROGRESS'] as const,
      },
    });
    vi.mocked(staffUnifiedQrAction).mockResolvedValue(result(false) as never);
    const { unmount } = render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Find customer/i, { selector: 'input' }), '+15551234567{Enter}');
    expect(await screen.findByText(/Phone not verified/)).toBeInTheDocument();
    unmount();

    vi.mocked(staffUnifiedQrAction).mockResolvedValue(result(true) as never);
    render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
    await user.type(screen.getByLabelText(/Find customer/i, { selector: 'input' }), '+15551234567{Enter}');
    expect(await screen.findByText('Amina')).toBeInTheDocument();
    expect(screen.queryByText(/Phone not verified/)).toBeNull();
  });

  it('offers no purchase for a membership that cannot take one', async () => {
    vi.mocked(staffUnifiedQrAction).mockResolvedValue({
      businessId: 'business',
      lookup: {
        lookupToken: 'lookup.token.value',
        displayName: 'Member',
        phoneMasked: '+•••••••4567',
        phoneVerified: true,
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

  describe('location selector and the search button', () => {
    it('hides the location selector when there is a single location and still sends its scope', () => {
      const { container } = render(
        <StaffQrMenu contexts={[{ branchId: 'branch-7', branchName: 'Main street' }]} />,
      );
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByText('Authorized business or branch')).toBeNull();
      expect(container.querySelector('input[type="hidden"][name="branchId"]')).toHaveValue('branch-7');
    });

    it('sends an empty scope for single business-wide access', () => {
      const { container } = render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
      expect(container.querySelector('input[type="hidden"][name="branchId"]')).toHaveValue('');
    });

    it('keeps the selector, translated, for a cashier who works at several locations', () => {
      render(
        <StaffQrMenu
          contexts={[
            { branchId: null, branchName: null },
            { branchId: 'branch-7', branchName: 'Main street' },
          ]}
        />,
      );
      const select = screen.getByLabelText('Location');
      expect(select).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Business-wide access' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Main street' })).toBeInTheDocument();
    });

    it('shows one clearly labelled submit button straight after the field', () => {
      render(<StaffQrMenu contexts={[{ branchId: null, branchName: null }]} />);
      expect(screen.queryByRole('button', { name: 'Resolve permitted actions' })).toBeNull();
      const button = screen.getByRole('button', { name: 'Find customer' });
      expect((button as HTMLButtonElement).type).toBe('submit');
      const field = screen.getByLabelText(/Find customer: scan/i, {
        selector: 'input',
      }) as HTMLInputElement;
      expect(field).toHaveAttribute('enterkeyhint', 'search');
      expect(field.form).toBe(button.closest('form'));
      // the button follows the field in document order, with no selector in between
      expect(field.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('customer card after a scan', () => {
    const scanWith = async (result: Record<string, unknown>) => {
      const serveAction = vi.fn<typeof staffUnifiedQrAction>().mockResolvedValueOnce({
        businessId: 'business',
        branchId: 'branch-7',
        token: 'signed.customer.qr',
        result: { customerId: 'customer', loyaltyAccountId: 'account', ...result },
      } as never);
      const user = userEvent.setup();
      render(<StaffQrMenu contexts={[{ branchId: 'branch-7', branchName: 'Main street' }]} serveAction={serveAction} />);
      const field = screen.getByLabelText(/Find customer/i, { selector: 'input' });
      await user.type(field, 'signed.customer.qr{Enter}');
      return serveAction;
    };

    it('shows the member card with name, points, tier, visits and which rewards are ready', async () => {
      await scanWith({
        membershipStatus: 'active',
        actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE', 'REDEEM_REWARD'],
        card: {
          displayName: 'Amina',
          points: 1250,
          tier: { name: 'Silver' },
          visitCount: 7,
          lastVisitAt: '2026-11-20T10:00:00.000Z',
          rewards: [
            { id: 'a', name: 'Free coffee', pointsCost: 100, enoughPoints: true, pointsNeeded: 0 },
            { id: 'b', name: 'Pastry', pointsCost: 1500, enoughPoints: false, pointsNeeded: 250 },
          ],
        },
      });
      expect(await screen.findByTestId('customer-card')).toBeVisible();
      expect(screen.getByText('Amina')).toBeVisible();
      expect(screen.getByText('Silver')).toBeVisible();
      expect(screen.getByTestId('card-points')).toHaveTextContent('1,250');
      expect(screen.getByText('Free coffee')).toBeVisible();
      expect(screen.getByText('Ready to redeem')).toBeVisible();
      expect(screen.getByText('250 more points needed')).toBeVisible();
      expect(screen.getAllByTestId('card-reward-ready')).toHaveLength(1);
      expect(screen.getAllByTestId('card-reward-locked')).toHaveLength(1);
      expect(screen.queryByTestId('not-a-member')).toBeNull();
    });

    it('says when the business has no rewards yet', async () => {
      await scanWith({
        membershipStatus: 'active',
        actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE'],
        card: { displayName: 'Member', points: 0, tier: null, visitCount: 0, lastVisitAt: null, rewards: [] },
      });
      expect(await screen.findByText('This business has not set up any rewards yet.')).toBeVisible();
    });

    it('tells the cashier a customer who has not joined is not a member, and shows no card', async () => {
      await scanWith({ membershipStatus: 'none', actions: [], card: null });
      expect(await screen.findByTestId('not-a-member')).toBeVisible();
      expect(screen.getByText('Not a member yet')).toBeVisible();
      expect(screen.queryByTestId('customer-card')).toBeNull();
    });

    it('still works against an API that returns no card field', async () => {
      await scanWith({ membershipStatus: 'active', actions: ['VIEW_ALLOWED_MEMBERSHIP_STATE'] });
      expect(await screen.findByText('Membership in this business: active')).toBeVisible();
      expect(screen.queryByTestId('customer-card')).toBeNull();
    });
  });
});
