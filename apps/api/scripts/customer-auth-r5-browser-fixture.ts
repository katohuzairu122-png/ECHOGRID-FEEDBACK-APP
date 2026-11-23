import { createServer } from 'node:http';
import { Client } from 'pg';
import { Hono } from 'hono';
import { buildDb } from '../src/db/client';
import { createDirectPbkdf2Worker } from '../src/auth/pbkdf2-worker';
import { createCustomerEmailTrustedSource } from '../src/customer-auth/customer-email-trusted-source';
import {
  createCustomerEmailAuthComposition,
  createEmailAuthDependencies,
  type EmailAuthRuntime,
} from '../src/customer-auth/customer-email-auth.composition';
import { createRegistrationProofDelivery } from '../src/customer-auth/customer-email-auth.delivery';
import {
  deriveEmailAuthSourceKey,
  type ResolvedEmailAuthConfig,
} from '../src/customer-auth/customer-email-auth.config';
import { createCustomerSessionLifecycleComposition } from '../src/customer-auth/customer-session-lifecycle.composition';
import { CustomerSessionService } from '../src/customer-auth/customer-session.service';
import type { EmailMessage, EmailService } from '../src/notifications/email.service';

const connectionString = process.env.DATABASE_URL;
const database = new URL(connectionString ?? 'postgresql://localhost/unknown');
const fixtureToken = process.env.CUSTOMER_AUTH_R5_MAILBOX_TOKEN;
const attributionSecret = process.env.CLIENT_ATTRIBUTION_SECRET;
const hmacSecret = process.env.CUSTOMER_EMAIL_AUTH_HMAC_SECRET;
const sessionSecret = process.env.CUSTOMER_SESSION_SIGNING_SECRET;
const legacySecret = process.env.CUSTOMER_JWT_SECRET;

if (
  process.env.CI !== 'true' ||
  process.env.CUSTOMER_AUTH_R5_TEST_ONLY !== 'true' ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.pathname !== '/echogrid_customer_auth_r5_test' ||
  !fixtureToken ||
  !attributionSecret ||
  !hmacSecret ||
  !sessionSecret ||
  !legacySecret ||
  [fixtureToken, attributionSecret, hmacSecret, sessionSecret, legacySecret].some(
    (value) => Buffer.byteLength(value) < 32,
  )
) {
  throw new Error('Customer-auth R5 fixture requires isolated CI PostgreSQL and per-run secrets.');
}

const mailboxes = new Map<string, EmailMessage[]>();
const budgets = new Map<string, { count: number; resetsAt: number }>();
const emailSink: EmailService = {
  async send(message) {
    if (!message.to.endsWith('@example.test'))
      throw new Error('The isolated mail sink accepts synthetic addresses only.');
    const messages = mailboxes.get(message.to) ?? [];
    messages.push(message);
    mailboxes.set(message.to, messages);
  },
};

const session: ResolvedEmailAuthConfig['session'] = {
  sessionSigningSecret: sessionSecret,
  legacySigningSecret: legacySecret,
  legacyAccepted: () => true,
  accessTtlSeconds: 900,
  refreshTtlSeconds: 3600,
  absoluteTtlSeconds: 7200,
  idleTtlSeconds: 1800,
  stepUpWindowSeconds: 600,
};
const config: ResolvedEmailAuthConfig = {
  hmacSecret,
  passwordMinLength: 8,
  webBaseUrl: 'http://localhost:3000',
  session,
};
const resolveTrustedSource = createCustomerEmailTrustedSource({
  attributionSecret,
  sourceKeySecret: await deriveEmailAuthSourceKey(hmacSecret),
});
const hasher = createDirectPbkdf2Worker();

async function withDb<T>(callback: (db: ReturnType<typeof buildDb>) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await callback(buildDb(client));
  } finally {
    await client.end();
  }
}

const testLimiter = async ({
  key,
  limit,
  windowSeconds,
}: {
  key: string;
  limit: number;
  windowSeconds: number;
}) => {
  const now = Date.now();
  const current = budgets.get(key);
  if (current && current.resetsAt > now) {
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }
  budgets.set(key, { count: 1, resetsAt: now + windowSeconds * 1000 });
  return true;
};

const emailAuth = createCustomerEmailAuthComposition({
  isEnabled: () => true,
  async open(): Promise<EmailAuthRuntime> {
    const dependencies = createEmailAuthDependencies(config, {
      withDb,
      hasher,
      deliver: createRegistrationProofDelivery({ email: emailSink, webBaseUrl: config.webBaseUrl }),
      limit: testLimiter,
      resolveTrustedSource,
    });
    return { dependencies, close: async () => {} };
  },
});

const lifecycle = createCustomerSessionLifecycleComposition({
  isEnabled: () => true,
  async open() {
    const client = new Client({ connectionString });
    await client.connect();
    const db = buildDb(client);
    return {
      sessions: new CustomerSessionService(db, config.session),
      resolveTrustedSource,
      close: () => client.end(),
    };
  },
});

const app = new Hono();
app.get('/health', (c) => c.body(null, 204));
app.get('/__test/mailbox', (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  const recipient = c.req.query('recipient') ?? '';
  if (!recipient.endsWith('@example.test')) return c.body(null, 404);
  return c.json({ messages: mailboxes.get(recipient) ?? [] }, 200, { 'Cache-Control': 'no-store' });
});
app.route('/api/v1/customer-auth', emailAuth);
app.route('/api/v1/customer-session', lifecycle);
app.onError(() => new Response('Internal Server Error', { status: 500 }));

const port = Number(process.env.CUSTOMER_AUTH_R5_API_PORT ?? '8792');
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(', '));
    }
    const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? '/'}`, {
      method: incoming.method,
      headers,
      ...(body ? { body, duplex: 'half' } : {}),
    } as RequestInit);
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(request, {}, {
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
      passThroughOnException() {},
      props: {},
    } as ExecutionContext);
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);
    outgoing.writeHead(response.status);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
    await Promise.allSettled(pending);
  } catch { 
    outgoing.writeHead(500);
    outgoing.end();
  }
});

server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
