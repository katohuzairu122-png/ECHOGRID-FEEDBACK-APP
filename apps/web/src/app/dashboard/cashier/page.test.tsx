import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ access: vi.fn(), api: vi.fn(), business: vi.fn(), url: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@/lib/permissions', () => ({ getMyAccess: m.access }));
vi.mock('@/lib/api-client', () => ({ apiFetch: m.api }));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('@/lib/cashier/host', () => ({ cashierAppUrl: m.url }));
vi.mock('@/components/workspace/restricted-panel', () => ({ RestrictedPanel: ({ variant }: { variant: string }) => <p>restricted:{variant}</p> }));
vi.mock('./cashier-sessions-panel', () => ({ CashierSessionsPanel: ({ sessions }: { sessions: unknown[] }) => <p>sessions:{sessions.length}</p> }));

import CashierAppPage from './page';

const as = (...permissions: string[]) => m.access.mockResolvedValue({ known: true, permissions: new Set(permissions) });

beforeEach(() => {
  vi.clearAllMocks();
  m.business.mockResolvedValue({ id: 'biz-1' });
  m.api.mockResolvedValue([{ sessionId: 's1' }]);
  m.url.mockReturnValue('https://cashier.echo-grid.uk/cashier');
});

describe('dashboard cashier app entry', () => {
  it('an owner (serve + manage) can open the app and manage sessions, with no extra setup', async () => {
    as('loyalty:serve', 'business:manage_settings');
    render(await CashierAppPage());
    const link = screen.getByRole('link', { name: 'open' });
    expect(link).toHaveAttribute('href', 'https://cashier.echo-grid.uk/cashier');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('ownerNote')).toBeInTheDocument();
    expect(screen.getByText('sessions:1')).toBeInTheDocument();
    expect(m.api).toHaveBeenCalledWith('/cashier-sessions', expect.objectContaining({ businessId: 'biz-1' }));
  });

  it('a manager or counter staff member (serve only) can open the app but sees no session management', async () => {
    as('loyalty:serve');
    render(await CashierAppPage());
    expect(screen.getByRole('link', { name: 'open' })).toBeInTheDocument();
    expect(screen.queryByText(/sessions:/)).not.toBeInTheDocument();
    expect(m.api).not.toHaveBeenCalled();
  });

  it('a role without loyalty:serve gets an explanation and no link', async () => {
    as('business:view');
    render(await CashierAppPage());
    expect(screen.getByText('noAccess')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'open' })).not.toBeInTheDocument();
  });

  it('shows install guidance, including the unsupported-browser note', async () => {
    as('loyalty:serve');
    render(await CashierAppPage());
    for (const k of ['steps.android', 'steps.ios', 'steps.desktop', 'unsupportedNote']) expect(screen.getByText(k)).toBeInTheDocument();
  });

  it('degrades gracefully when the cashier app is not deployed for this environment', async () => {
    as('loyalty:serve');
    m.url.mockReturnValue(null);
    render(await CashierAppPage());
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'open' })).not.toBeInTheDocument();
  });

  it('unconfirmed permissions show the unavailable state, never an elevated one', async () => {
    m.access.mockResolvedValue({ known: false, permissions: new Set() });
    render(await CashierAppPage());
    expect(screen.getByText('restricted:unavailable')).toBeInTheDocument();
  });

  it('a failed session read shows an error rather than an empty list', async () => {
    as('loyalty:serve', 'business:manage_settings');
    m.api.mockRejectedValue(new Error('down'));
    render(await CashierAppPage());
    expect(screen.getByText('sessions.loadFailed')).toBeInTheDocument();
  });
});
