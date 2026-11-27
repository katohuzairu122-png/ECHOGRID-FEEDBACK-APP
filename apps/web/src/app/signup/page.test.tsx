import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils';
import en from '../../../messages/en/auth.json';
import es from '../../../messages/es/auth.json';
import fr from '../../../messages/fr/auth.json';
import ar from '../../../messages/ar/auth.json';
import SignupPage from './page';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/actions/auth', () => ({ signupAction: vi.fn() }));
vi.mock('@/lib/cashier/host-guard', () => ({ keepStaffSurfacesOffCashierHost: async () => undefined }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: { auth: en }, namespace: namespace as never }),
}));

async function renderPage(searchParams: { role?: string; next?: string }) {
  return renderWithIntl(await SignupPage({ searchParams: Promise.resolve(searchParams) }));
}

describe('registration entry: choose how to participate (LANDING-ROLE-01)', () => {
  it('asks first, offering a business-owner path and a loyalty-customer path', async () => {
    await renderPage({});
    expect(screen.getByRole('heading', { name: 'Choose how to participate on Echo Grid' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a business account' })).toHaveAttribute('href', '/signup?role=business');
    expect(screen.getByRole('link', { name: 'Join as a customer' })).toHaveAttribute('href', '/loyalty/join');
    expect(screen.getByRole('link', { name: 'Business log in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Customer sign in' })).toHaveAttribute('href', '/loyalty/login');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('shows the unchanged business-owner form for ?role=business', async () => {
    await renderPage({ role: 'business' });
    for (const field of ['Full name', 'Email', 'Password']) expect(screen.getByLabelText(field)).toBeRequired();
    expect(screen.queryByRole('link', { name: 'Join as a customer' })).not.toBeInTheDocument();
  });

  it('goes straight to the owner form for a team invitation, and labels it a business account with a customer escape', async () => {
    await renderPage({ next: '/invite/abc' });
    expect(screen.getByLabelText('Password')).toBeRequired();
    expect(screen.getByText('Business owner account')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Join as a customer instead' })).toHaveAttribute('href', '/loyalty/join');
    expect(screen.queryByText('Choose how to participate on Echo Grid')).not.toBeInTheDocument();
  });

  it('still asks which account type for any other destination (a customer must not land on the owner form by accident)', async () => {
    await renderPage({ next: '/dashboard/team' });
    expect(screen.getByRole('heading', { name: 'Choose how to participate on Echo Grid' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('ignores any other role value and an empty next (falls back to the chooser)', async () => {
    await renderPage({ role: 'admin', next: '' });
    expect(screen.getByRole('heading', { name: 'Choose how to participate on Echo Grid' })).toBeInTheDocument();
  });

  it('has every chooser string in all four languages', () => {
    const keys = Object.keys((en as { chooser: Record<string, string> }).chooser).sort();
    for (const locale of [es, fr, ar]) {
      const chooser = (locale as { chooser: Record<string, string> }).chooser;
      expect(Object.keys(chooser).sort()).toEqual(keys);
      for (const key of keys) expect(chooser[key]!.trim().length).toBeGreaterThan(0);
    }
    render(<span />);
  });
});
