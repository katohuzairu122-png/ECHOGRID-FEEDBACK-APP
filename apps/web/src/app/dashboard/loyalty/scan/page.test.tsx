import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business', () => ({ getActiveBusiness: async () => ({ id: 'biz-1', name: 'Buddy Coffee' }) }));
vi.mock('@/lib/api-client', () => ({ apiFetch: async () => [{ branchId: null, branchName: null }] }));
vi.mock('@/lib/platform', () => ({ getCurrentUser: async () => ({ fullName: 'Ada Owner' }) }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => (key === 'cashierAppLink' ? 'Cashier app link' : key) }));
vi.mock('./staff-qr-menu', () => ({ StaffQrMenu: () => <div data-testid="menu" /> }));

import StaffQrPage from './page';

describe('Serve customers page', () => {
  it('is the one counter tab: it leads to the Cashier app page (install, sessions, cashier accounts) instead of a second tab', async () => {
    render(await StaffQrPage());
    expect(screen.getByRole('link', { name: 'Cashier app link' })).toHaveAttribute('href', '/dashboard/cashier');
    expect(screen.getByTestId('menu')).toBeInTheDocument();
  });
});
