import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from 'pg';
import { buildDb } from '../src/db/client';
import { createDirectPbkdf2Worker } from '../src/auth/pbkdf2-worker';
import { CustomerPasswordAuthService } from '../src/customer-auth/customer-password-auth.service';
import { CustomerSessionService } from '../src/customer-auth/customer-session.service';
import { createCustomerSessionLifecycleRoutes } from '../src/customer-auth/customer-session-lifecycle.routes';
import { createCustomerLanguageRoutes } from '../src/customer-language/customer-language.routes';
import { createCustomerAuthenticate } from '../src/middleware/customer-authenticate';
import type { Bindings } from '../src/config/env';
import { AppError } from '../src/lib/errors';

const connectionString = process.env.DATABASE_URL;
const database = new URL(connectionString ?? 'postgresql://localhost/unknown');
if (process.env.CI !== 'true' || !['localhost', '127.0.0.1'].includes(database.hostname)
    || database.pathname !== '/echogrid_w4_test') {
  throw new Error('Customer session browser fixture requires disposable CI PostgreSQL');
}
const client = new Client({ connectionString });
await client.connect();
const db = buildDb(client);
const sessions = new CustomerSessionService(db, {
  sessionSigningSecret: randomBytes(32).toString('hex'),
  legacySigningSecret: randomBytes(32).toString('hex'),
  legacyAccepted: () => true,
  accessTtlSeconds: 8,
  refreshTtlSeconds: 86400,
  absoluteTtlSeconds: 30 * 86400,
  idleTtlSeconds: 86400,
  stepUpWindowSeconds: 600,
});
const auth = new CustomerPasswordAuthService(db, sessions, createDirectPbkdf2Worker(), {
  passwordMinLength: 12,
  phoneProofMaxAgeSeconds: 300,
  passwordIterations: 1000,
});
const email = 'r2-browser@example.test';
const password = 'synthetic customer session passphrase';
const created = await auth.registerWithPassword({
  phone: '+15559990202', verifiedAt: new Date(), source: 'local_otp',
}, password);
if (!created.ok) throw new Error('Synthetic customer registration failed');
await client.query(
  "UPDATE customer_credentials SET login_email=$1, login_email_verified_at=now() WHERE customer_id=$2",
  [email, created.session.customerId],
);
await client.query("UPDATE customers SET preferred_locale='ar' WHERE id=$1", [created.session.customerId]);
const lifecycle = createCustomerSessionLifecycleRoutes(sessions);
const language = createCustomerLanguageRoutes(
  createCustomerAuthenticate(sessions),
  async () => ({ db, close: async () => {} }),
).onError((error, c) => c.body(null, error instanceof AppError ? error.status : 500));

createServer(async (req, res) => {
  try {
    const path = req.url ?? '/';
    const headers = new Headers();
    if (req.headers.authorization) headers.set('authorization', req.headers.authorization);
    let response: Response;
    if (path === '/health') response = new Response(null, { status: 204 });
    else if (path === '/login' && req.method === 'POST') {
      const result = await auth.loginWithVerifiedEmailPassword({ email, password });
      response = result.ok ? Response.json(result.session) : new Response(null, { status: 401 });
    } else if (path === '/customer-language' && req.method === 'GET') {
      response = await language.request('/', { headers }, {
        PUBLIC_RATE_LIMITER: { limit: async () => ({ success: true }) },
      } as unknown as Bindings, {
        waitUntil: () => {}, passThroughOnException: () => {}, props: {},
      });
    } else if (['/refresh', '/logout'].includes(path) && req.method === 'POST') {
      response = await lifecycle.request(path, { method: 'POST', headers });
    } else response = new Response(null, { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end();
  }
}).listen(8792, '127.0.0.1');
