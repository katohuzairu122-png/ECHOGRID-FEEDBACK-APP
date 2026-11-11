import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import BusinessLayout from '@/app/dashboard/layout';
import CustomerLayout from '@/app/loyalty/dashboard/layout';
import PlatformLayout from '@/app/platform/layout';
import { getBusinesses } from '@/lib/business';
import { getCurrentUser } from '@/lib/platform';

const identity = vi.hoisted(() => ({ staff: false, customer: false, role: null as string | null }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error('redirect:' + path);
  },
  usePathname: () => '/platform',
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/session', () => ({
  hasSession: async () => identity.staff,
  isImpersonating: async () => false,
}));
vi.mock('@/lib/customer-session', () => ({ hasCustomerSession: async () => identity.customer }));
vi.mock('@/lib/business', () => ({
  getBusinesses: vi.fn(async () => []),
  getActiveBusinessQuiet: async () => null,
}));
vi.mock('@/lib/platform', () => ({
  getCurrentUser: vi.fn(async () => ({ platformRole: identity.role })),
}));
vi.mock('@/lib/actions/auth', () => ({ logoutAction: vi.fn() }));
vi.mock('@/lib/actions/customer-auth', () => ({ customerLogoutAction: vi.fn() }));
describe('authenticated workspace layout boundaries', () => {
  beforeEach(() => {
    identity.staff = false;
    identity.customer = false;
    identity.role = null;
    vi.clearAllMocks();
  });
  it('does not fetch business context before staff authentication', async () => {
    await expect(BusinessLayout({ children: null })).rejects.toThrow('redirect:/login');
    expect(getBusinesses).not.toHaveBeenCalled();
  });
  it('does not accept a customer session as staff authentication', async () => {
    identity.customer = true;
    await expect(BusinessLayout({ children: null })).rejects.toThrow('redirect:/login');
  });
  it('does not accept a staff session as customer authentication', async () => {
    identity.staff = true;
    await expect(CustomerLayout({ children: null })).rejects.toThrow('redirect:/loyalty/login');
  });
  it('requires staff authentication before reading platform identity', async () => {
    await expect(PlatformLayout({ children: null })).rejects.toThrow('redirect:/login');
    expect(getCurrentUser).not.toHaveBeenCalled();
  });
  it('denies platform presentation to ordinary authenticated business staff', async () => {
    identity.staff = true;
    render(await PlatformLayout({ children: <p>Private platform content</p> }));
    expect(screen.queryByText('Private platform content')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'title' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'backToDashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });
});
