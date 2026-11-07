import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context, type Next } from 'hono';
import type { Bindings } from './config/env';
import type { CustomerAuthVariables } from './middleware/customer-authenticate';
import { AppError } from './lib/errors';

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  listParticipations: vi.fn(),
  listConsents: vi.fn(),
  close: vi.fn(),
}));

vi.mock('./middleware/customer-authenticate', () => ({
  customerAuthenticate: async (c: Context<{ Variables: CustomerAuthVariables }>, next: Next) => {
    c.set('customerId', 'customer-scoped');
    await next();
  },
}));
vi.mock('./middleware/rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: Next) => next(),
}));
vi.mock('./db/client', () => ({
  createDb: mocks.createDb,
}));
vi.mock('./repositories', () => ({
  createRepositories: () => ({
    surveyParticipations: { listForCustomer: mocks.listParticipations },
    consentGrants: { listForCustomer: mocks.listConsents },
  }),
}));

import { consentRoutes } from './consent/consent.routes';
import { surveyCustomerRoutes } from './surveys/survey-customer.routes';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

const app = new Hono<Env>();
app.onError((err, c) => c.json(
  { code: err instanceof AppError ? err.code : 'UNEXPECTED' },
  err instanceof AppError ? err.status : 500,
));
app.route('/consent', consentRoutes);
app.route('/surveys', surveyCustomerRoutes);
const context = { waitUntil() {}, passThroughOnException() {}, props: {} };

function request(path: string) {
  return app.fetch(new Request(`https://example.test${path}`), {} as Bindings, context);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listParticipations.mockResolvedValue([]);
  mocks.listConsents.mockResolvedValue([]);
  mocks.close.mockResolvedValue(undefined);
  mocks.createDb.mockResolvedValue({ db: {}, close: mocks.close });
});

describe('Group 12 customer history pagination regression', () => {
  const endpoints = [
    { path: '/surveys/participations', list: mocks.listParticipations },
    { path: '/consent', list: mocks.listConsents },
  ];

  it.each(endpoints)('DEV-80 uses a bounded customer-scoped default at $path', async ({ path, list }) => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [] });
    expect(list).toHaveBeenCalledExactlyOnceWith('customer-scoped', { limit: 100, offset: 0 });
    expect(mocks.createDb).toHaveBeenCalledTimes(1);
  });

  it.each(endpoints)('DEV-81 supports explicit pagination at $path', async ({ path, list }) => {
    const response = await request(`${path}?limit=25&offset=100`);
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledExactlyOnceWith('customer-scoped', { limit: 25, offset: 100 });
  });

  it.each(endpoints)('DEV-81 permits the supported upper bounds at $path', async ({ path, list }) => {
    const response = await request(`${path}?limit=100&offset=1000000`);
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledExactlyOnceWith('customer-scoped', { limit: 100, offset: 1000000 });
  });

  const invalidQueries = [
    'limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=1e2',
    'limit=%201', 'limit=01', 'limit=Infinity', 'limit=1&limit=2',
    'offset=-1', 'offset=1000001', 'offset=1.5', 'offset=1&offset=2',
  ];
  it.each(endpoints.flatMap(({ path }) => invalidQueries.map(query => ({ path, query }))))(
    'DEV-82 rejects invalid pagination before opening the database: $path?$query',
    async ({ path, query }) => {
      const response = await request(`${path}?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: 'INVALID_PAGINATION' });
      expect(mocks.createDb).not.toHaveBeenCalled();
      expect(mocks.listParticipations).not.toHaveBeenCalled();
      expect(mocks.listConsents).not.toHaveBeenCalled();
    },
  );
});
