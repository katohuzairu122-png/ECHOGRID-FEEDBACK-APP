import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';

/**
 * Cashier (front-counter Staff) authorization boundary, exercised through the REAL loyaltyRoutes router and
 * the real tenant-context and permission middleware. Only identity, membership and the permission grants are
 * fixtures; the service layer is a stub that must never be reached by a denied request.
 */
const mocks = vi.hoisted(() => ({
  permissions: vi.fn(),
  dbReached: vi.fn(),
}));

vi.mock('../middleware/authenticate', () => ({
  authenticate: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', 'cashier-1');
    await next();
  },
}));
vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: async () => undefined })),
}));
// Any service method invoked means a request passed every middleware gate and reached business logic.
const reached = () =>
  new Proxy(
    {},
    {
      get: () => () => {
        mocks.dbReached();
        throw new Error('handler-reached');
      },
    },
  );
vi.mock('./loyalty-account.service', () => ({
  LoyaltyAccountService: class {
    constructor() {
      return reached();
    }
  },
}));
vi.mock('./loyalty-tier.service', () => ({
  LoyaltyTierService: class {
    constructor() {
      return reached();
    }
  },
}));
vi.mock('./loyalty-reward.service', () => ({
  LoyaltyRewardService: class {
    constructor() {
      return reached();
    }
  },
}));
vi.mock('./loyalty-redemption.service', () => ({
  LoyaltyRedemptionService: class {
    constructor() {
      return reached();
    }
  },
}));
vi.mock('./loyalty-action-resolver', () => ({
  LoyaltyActionResolver: class {
    constructor() {
      return reached();
    }
  },
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({
    userBusinessRoles: { listForUserAtBusiness: async () => [{ branchId: null }] },
    businesses: { findById: async () => ({ status: 'active' }) },
    branches: { findById: async () => undefined },
    permissions: { findEffectiveKeys: mocks.permissions },
  })),
}));

import { errorHandler } from '../lib/error-handler';
import { loyaltyRoutes } from './loyalty.routes';

const app = new Hono<{ Bindings: Bindings }>();
app.onError(errorHandler);
app.route('/', loyaltyRoutes);

const STAFF_DEFAULT = [
  'business:view',
  'branches:view',
  'feedback:view',
  'loyalty:view',
  'loyalty:manage',
  'messages:view',
  'messages:send',
];
const MANAGER_ADMIN_OWNER = [...STAFF_DEFAULT, 'rewards:manage', 'analytics:view'];

function call(method: string, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { 'X-Business-Id': 'business-a', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {} as Bindings,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
  );
}

async function code(res: Response) {
  return ((await res.json()) as { error?: { code?: string }; code?: string }).error?.code;
}

describe('cashier boundary: loyalty API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('with the default Staff (cashier) grants', () => {
    beforeEach(() => mocks.permissions.mockResolvedValue(new Set(STAFF_DEFAULT)));

    it('cannot manually adjust a balance (403, handler never reached)', async () => {
      const res = await call('POST', '/accounts/acct-1/adjust', { points: 50, notes: 'x' });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('PERMISSION_DENIED');
      expect(mocks.dbReached).not.toHaveBeenCalled();
    });

    it.each([
      ['POST', '/tiers'],
      ['PATCH', '/tiers/t1'],
      ['DELETE', '/tiers/t1'],
      ['POST', '/rewards'],
      ['PATCH', '/rewards/r1'],
      ['DELETE', '/rewards/r1'],
      ['PATCH', '/settings'],
    ])('cannot configure the programme: %s %s', async (method, path) => {
      const res = await call(method, path, {});
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('PERMISSION_DENIED');
      expect(mocks.dbReached).not.toHaveBeenCalled();
    });

    it.each([
      ['POST', '/actions/resolve-customer', { customerQrToken: 'fixture-token' }],
      [
        'POST',
        '/accounts/acct-1/purchase',
        { purchaseAmount: 5, idempotencyKey: 'k-0000001', channel: 'other' },
      ],
      ['POST', '/redemptions/CODE1234/confirm', {}],
    ])('still reaches the counter-service handler: %s %s', async (method, path, body) => {
      const res = await call(method, path, body);
      // The permission layer let it through; the stubbed service is what stops it (500), not a 401/403.
      expect([401, 403]).not.toContain(res.status);
      expect(mocks.dbReached).toHaveBeenCalled();
    });
  });

  describe('with Manager/Admin/Owner grants (regression guard)', () => {
    beforeEach(() => mocks.permissions.mockResolvedValue(new Set(MANAGER_ADMIN_OWNER)));

    it('can still reach manual adjustment (permission layer passes)', async () => {
      const res = await call('POST', '/accounts/acct-1/adjust', {
        points: 50,
        notes: 'correction',
      });
      expect([401, 403]).not.toContain(res.status);
      expect(mocks.dbReached).toHaveBeenCalled();
    });
  });

  it('a role with only loyalty:manage (no rewards:manage) is denied adjustment', async () => {
    mocks.permissions.mockResolvedValue(new Set(['loyalty:manage']));
    const res = await call('POST', '/accounts/acct-1/adjust', { points: 1, notes: 'x' });
    expect(res.status).toBe(403);
  });
});
