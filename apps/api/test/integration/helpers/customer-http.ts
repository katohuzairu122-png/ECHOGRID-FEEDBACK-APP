import { Hono } from 'hono';
import type { Bindings } from '../../../src/config/env';
import { consentRoutes } from '../../../src/consent/consent.routes';
import { customerMembershipRoutes } from '../../../src/customer-relationships/customer-membership.routes';
import type { VelocityKv } from '../../../src/fraud/velocity-tracker';
import { errorHandler } from '../../../src/lib/error-handler';
import { loyaltyCustomerRoutes } from '../../../src/loyalty/loyalty-customer.routes';

/**
 * Real-HTTP harness for the customer-facing Split 01 routes: the Hono routers are mounted at the
 * same paths as production and driven through `app.request`, against a disposable PostgreSQL
 * database. Secrets and the in-memory KV are fixtures; nothing here reaches a real service.
 */
export const CUSTOMER_JWT_SECRET = 'customer-http-fixture-customer-only';
export const QR_TOKEN_SECRET = 'customer-http-fixture-qr-secret-do-not-use';
const allow = { limit: async () => ({ success: true }) };

export type Envelope<T> = { data?: T; error?: { code: string; message?: string } };
export type CustomerResponse<T> = { status: number } & Envelope<T>;

const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/loyalty/me', loyaltyCustomerRoutes);
app.route('/api/v1/customer-memberships', customerMembershipRoutes);
app.route('/api/v1/consents', consentRoutes);
app.onError(errorHandler);

/** In-memory stand-in for the CACHE binding, shared across the calls of one test. */
export function createFakeKv(): VelocityKv {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() / 1000 >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, options: { expirationTtl: number }) {
      store.set(key, { value, expiresAt: Date.now() / 1000 + options.expirationTtl });
    },
  };
}

/** One customer-authenticated request against `/api/v1${path}`; resolves once background work has settled. */
export async function customerRequest<T = unknown>(
  databaseUrl: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  kv: VelocityKv,
): Promise<CustomerResponse<T>> {
  const pending: Promise<unknown>[] = [];
  const env = {
    HYPERDRIVE: { connectionString: databaseUrl },
    CUSTOMER_JWT_SECRET,
    QR_TOKEN_SECRET,
    FRAUD_DETECTION_SALT: 'customer-http-fixture-salt-do-not-use-in-production',
    CACHE: kv,
    CUSTOMER_API_RATE_LIMITER: allow,
    PUBLIC_RATE_LIMITER: allow,
    JOBS: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Bindings;
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await app.request(
    `/api/v1${path}`,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env,
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    },
  );
  await Promise.all(pending);
  const text = await response.text();
  return { status: response.status, ...((text ? JSON.parse(text) : {}) as Envelope<T>) };
}
