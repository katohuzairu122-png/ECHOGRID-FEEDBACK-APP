import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardNav } from './dashboard-nav';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock('@/lib/actions/auth', () => ({
  logoutAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: vi.fn() }),
}));

describe('DashboardNav responsive navigation', () => {
  it('keeps desktop links and provides a phone/tablet menu with the same destinations', async () => {
    const { container } = render(await DashboardNav());

    expect(container.querySelector('nav.lg\\:flex')).toHaveClass('hidden');
    expect(container.querySelector('details.lg\\:hidden')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'nav.analytics' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'nav.billing' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'nav.logout' })).toHaveLength(2);
  });
});
