import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ access: vi.fn(), api: vi.fn(), business: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` }); },
}));
vi.mock('@/lib/permissions', () => ({ getMyAccess: m.access }));
vi.mock('@/lib/api-client', () => ({ apiFetch: m.api, ApiError: class extends Error {} }));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('@/components/workspace/restricted-panel', () => ({ RestrictedPanel: ({ variant }: { variant: string }) => <p>restricted:{variant}</p> }));
vi.mock('./cashier-accounts-view', () => ({
  CashierAccountsView: (p: { accounts: unknown[]; branches: { name: string }[]; code: { cashierCode: string | null } }) =>
    <p>view:{p.accounts.length}:{p.branches.map((b) => b.name).join(',')}:{p.code.cashierCode}</p>,
}));

import CashierAccountsPage from './page';

const as = (...permissions: string[]) => m.access.mockResolvedValue({ known: true, permissions: new Set(permissions) });

beforeEach(() => {
  vi.clearAllMocks();
  m.business.mockResolvedValue({ id: 'biz-1' });
  m.api.mockImplementation(async (path: string) => {
    if (path === '/cashier-accounts') return [{ id: 'a1' }];
    if (path === '/cashier-accounts/business-code') return { cashierCode: 'ABCDEFGHJK', rotatedAt: null };
    if (path === '/branches') return [{ id: 'b1', name: 'Main', extra: 'ignored' }];
    throw new Error(path);
  });
});

describe('cashier accounts page (presentation gate; the API enforces the same)', () => {
  it('without cashier:manage it explains and reads nothing (a Manager, a cashier, staff)', async () => {
    as('loyalty:serve', 'business:manage_settings', 'team:view');
    render(await CashierAccountsPage());
    expect(screen.getByText('noAccess')).toBeInTheDocument();
    expect(m.api).not.toHaveBeenCalled();
  });

  it('an unknown access reading is shown as unavailable, never as an elevated view', async () => {
    m.access.mockResolvedValue({ known: false, permissions: new Set() });
    render(await CashierAccountsPage());
    expect(screen.getByText('restricted:unavailable')).toBeInTheDocument();
    expect(m.api).not.toHaveBeenCalled();
  });

  it('with cashier:manage it loads this business accounts, code and branches only', async () => {
    as('cashier:manage');
    render(await CashierAccountsPage());
    expect(screen.getByText('view:1:Main:ABCDEFGHJK')).toBeInTheDocument();
    for (const call of m.api.mock.calls) expect(call[1]).toMatchObject({ businessId: 'biz-1', cache: 'no-store' });
  });

  it('a failed read is an error message, not an empty list', async () => {
    as('cashier:manage');
    m.api.mockRejectedValue(new Error('down'));
    render(await CashierAccountsPage());
    expect(screen.getByText('loadFailed')).toBeInTheDocument();
    expect(screen.queryByText(/^view:/)).not.toBeInTheDocument();
  });
});
