import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ access: vi.fn(), api: vi.fn(), business: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => Object.assign((k: string) => k, { has: () => true }),
  getFormatter: async () => ({ dateTime: () => 'DATE' }),
}));
vi.mock('@/lib/permissions', () => ({ getMyAccess: m.access }));
vi.mock('@/lib/api-client', () => ({
  apiFetch: m.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number, public code?: string) {
      super(message);
    }
  },
}));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('@/components/workspace/restricted-panel', () => ({ RestrictedPanel: ({ variant }: { variant: string }) => <p>restricted:{variant}</p> }));

import { ApiError } from '@/lib/api-client';
import CashierActivityPage from './page';

const as = (...p: string[]) => m.access.mockResolvedValue({ known: true, permissions: new Set(p) });
const page = (sp: Record<string, string> = {}) => CashierActivityPage({ searchParams: Promise.resolve(sp) });
const item = (over: Record<string, unknown> = {}) => ({
  correlationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  timestamp: '2026-01-01T10:00:00Z',
  branchId: 'b1',
  branchName: 'Main',
  actor: { id: 'u', name: 'Pat' },
  action: 'loyalty.purchase_recorded',
  outcome: 'success',
  reference: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.business.mockResolvedValue({ id: 'biz-1' });
  m.api.mockImplementation(async (path: string) => (path.startsWith('/branches') ? [{ id: 'b1', name: 'Main' }] : { items: [item()], nextCursor: null }));
});

describe('cashier activity page', () => {
  it('renders rows with actor, branch, outcome and a short reference; no customer data is in the contract', async () => {
    as('audit:view');
    render(await page());
    expect(screen.getByText('Pat')).toBeInTheDocument();
    expect(screen.getAllByText('Main').length).toBeGreaterThan(0);
    expect(screen.getByText('outcome.success')).toBeInTheDocument();
    expect(screen.getByText('aaaaaaaa')).toBeInTheDocument();
  });

  it('a Manager (loyalty:accounts:view) can read; a counter-only role gets an explanation and no API call', async () => {
    as('loyalty:accounts:view');
    render(await page());
    expect(screen.getByText('Pat')).toBeInTheDocument();
    vi.clearAllMocks();
    as('loyalty:serve');
    const { container } = render(await page());
    expect(container).toHaveTextContent('noAccess');
    expect(m.api).not.toHaveBeenCalled();
  });

  it('passes validated filters through, and drops unknown or malformed ones', async () => {
    as('audit:view');
    await page({ category: 'redemption_failure', branchId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', cursor: 'CUR' });
    const call = m.api.mock.calls.find((c) => String(c[0]).startsWith('/cashier-activity'))!;
    expect(call[0]).toContain('category=redemption_failure');
    expect(call[0]).toContain('branchId=c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1');
    expect(call[0]).toContain('cursor=CUR');
    expect(call[1]).toMatchObject({ businessId: 'biz-1', branchId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1' });
    vi.clearAllMocks();
    await page({ category: 'drop table', branchId: '../x' });
    const path = String(m.api.mock.calls.find((c) => String(c[0]).startsWith('/cashier-activity'))![0]);
    expect(path).not.toContain('category');
    expect(path).not.toContain('branchId');
  });

  it('offers older activity when another page exists, and shows empty and error states', async () => {
    as('audit:view');
    m.api.mockImplementation(async (p: string) => (p.startsWith('/branches') ? [] : { items: [item()], nextCursor: 'NEXT' }));
    render(await page());
    expect(screen.getByRole('link', { name: 'older' })).toHaveAttribute('href', expect.stringContaining('cursor=NEXT'));
    m.api.mockImplementation(async (p: string) => (p.startsWith('/branches') ? [] : { items: [], nextCursor: null }));
    const empty = render(await page());
    expect(empty.container).toHaveTextContent('empty');
    m.api.mockImplementation(async (p: string) => {
      if (p.startsWith('/branches')) return [];
      throw new ApiError('x', 403, 'BRANCH_CONTEXT_REQUIRED');
    });
    const err = render(await page());
    expect(err.container).toHaveTextContent('branchRequired');
  });

  it('unconfirmed permissions show the unavailable state', async () => {
    m.access.mockResolvedValue({ known: false, permissions: new Set() });
    render(await page());
    expect(screen.getByText('restricted:unavailable')).toBeInTheDocument();
  });
});
