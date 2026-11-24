import { createServer } from 'node:http';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
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
import { CustomerPasswordAuthService } from '../src/customer-auth/customer-password-auth.service';
import { normalizePassword } from '../src/customer-auth/customer-password-policy';
import { CustomerCredentialRepository } from '../src/repositories/customer-credential.repository';
import { CustomerRepository } from '../src/repositories/customer.repository';
import { createCustomerRecoveryService } from '../src/customer-auth/customer-recovery-attempt.service';
import { createCustomerRecoveryRoutes } from '../src/customer-auth/customer-recovery.routes';
import {
  createRecoveryEmailChallengeDelivery,
  createRecoveryNotifier,
} from '../src/customer-auth/customer-recovery-delivery';
import {
  customerChallengeDigest,
  normalizeLoginEmail,
} from '../src/customer-auth/customer-email-challenge-digest';
import type { EmailMessage, EmailService } from '../src/notifications/email.service';

const connectionString = process.env.DATABASE_URL;
const database = new URL(connectionString ?? 'postgresql://localhost/unknown');
const fixtureToken = process.env.CUSTOMER_AUTH_R5_MAILBOX_TOKEN;
const attributionSecret = process.env.CLIENT_ATTRIBUTION_SECRET;
const hmacSecret = process.env.CUSTOMER_EMAIL_AUTH_HMAC_SECRET;
const sessionSecret = process.env.CUSTOMER_SESSION_SIGNING_SECRET;
const legacySecret = process.env.CUSTOMER_JWT_SECRET;
const recoverySecret = process.env.CUSTOMER_RECOVERY_HMAC_SECRET;

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
  !recoverySecret ||
  [fixtureToken, attributionSecret, hmacSecret, sessionSecret, legacySecret, recoverySecret].some(
    (value) => Buffer.byteLength(value) < 32,
  )
) {
  throw new Error('Customer-auth R5 fixture requires isolated CI PostgreSQL and per-run secrets.');
}

const mailboxes = new Map<string, EmailMessage[]>();
const budgets = new Map<string, { count: number; resetsAt: number }>();
const recoveryPhoneCodes = new Map<string, string>();
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

const recoveryRoutes = createCustomerRecoveryRoutes({
  isEnabled: () => true,
  resolveTrustedSource: async (context) => resolveTrustedSource(context.req.raw),
  async open() {
    const client = new Client({ connectionString });
    await client.connect();
    const db = buildDb(client);
    const sessions = new CustomerSessionService(db, config.session);
    const passwordAuth = new CustomerPasswordAuthService(db, sessions, hasher, {
      passwordMinLength: config.passwordMinLength,
      phoneProofMaxAgeSeconds: 300,
    });
    const service = createCustomerRecoveryService({
      db,
      hmacSecret: recoverySecret,
      hasher,
      passwordPolicy: { minLength: config.passwordMinLength },
      limiter: testLimiter,
      notifier: createRecoveryNotifier({
        email: emailSink,
        sms: { async send() {} },
        webBaseUrl: config.webBaseUrl,
      }),
      deliverEmailChallenge: createRecoveryEmailChallengeDelivery({
        email: emailSink,
        webBaseUrl: config.webBaseUrl,
      }),
      phoneOtp: {
        async send(phone) {
          recoveryPhoneCodes.set(phone, '123456');
        },
        async check(phone, code) {
          if (recoveryPhoneCodes.get(phone) !== code) return false;
          recoveryPhoneCodes.delete(phone);
          return true;
        },
      },
      phoneProofMaxAgeSeconds: 300,
    });
    return {
      deps: {
        service,
        findCustomerIdByLoginEmail: async (address: string) => {
          const normalized = normalizeLoginEmail(address);
          if (!normalized) return null;
          const credential = await new CustomerCredentialRepository(db).findByLoginEmail(
            normalized,
          );
          return credential?.loginEmailVerifiedAt ? credential.customerId : null;
        },
        findCustomerIdByVerifiedPhone: async (phone: string) => {
          const customer = await new CustomerRepository(db).findVerifiedByPhone(phone);
          if (!customer) return null;
          const credential = await new CustomerCredentialRepository(db).findByCustomerId(
            customer.id,
          );
          return credential?.loginEmailVerifiedAt ? customer.id : null;
        },
        codeManagement: {
          authenticate: async (token: string) => {
            const identity = await sessions.authenticateSessionToken(token);
            return identity?.assurance === 'session' ? identity : null;
          },
          reauthenticate: ({
            customerId,
            sessionId,
            currentPassword,
          }: {
            customerId: string;
            sessionId: string;
            currentPassword: string;
          }) => passwordAuth.reauthenticateSession({ customerId, sessionId, currentPassword }),
          allow: async ({ sourceKey, customerId }: { sourceKey: string; customerId: string }) => {
            const [source, customer] = await Promise.all([
              customerChallengeDigest({
                secret: recoverySecret,
                purpose: 'email_recovery',
                field: 'subject',
                value: `recovery-code-source:${sourceKey}`,
              }),
              customerChallengeDigest({
                secret: recoverySecret,
                purpose: 'email_recovery',
                field: 'subject',
                value: `recovery-code-customer:${customerId}`,
              }),
            ]);
            const allowed = await Promise.all([
              testLimiter({
                key: `customer-recovery:code-management:source:${source}`,
                limit: 5,
                windowSeconds: 900,
              }),
              testLimiter({
                key: `customer-recovery:code-management:customer:${customer}`,
                limit: 5,
                windowSeconds: 900,
              }),
            ]);
            return allowed.every(Boolean);
          },
          issue: async () => ({ ok: false as const }),
          revoke: async () => ({ ok: false as const }),
        },
      },
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
app.post('/__test/mark-phone-verified', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  const payload = (await c.req.json().catch(() => null)) as { recipient?: unknown } | null;
  const recipient = typeof payload?.recipient === 'string' ? payload.recipient : '';
  if (!recipient.endsWith('@example.test')) return c.body(null, 404);
  const phone = `+1${Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => String(byte % 10)).join('')}`;
  await withDb(async (db) => {
    await db.execute(sql`UPDATE customers c SET phone = ${phone}, phone_verified_at = now() - interval '30 days'
      FROM customer_credentials cc
      WHERE cc.customer_id = c.id AND cc.login_email = ${recipient}
        AND cc.login_email_verified_at IS NOT NULL AND c.phone IS NULL`);
  });
  return c.json({ accepted: true }, 200, { 'Cache-Control': 'no-store' });
});
app.post('/__test/advance-recovery-hold', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  const payload = (await c.req.json().catch(() => null)) as { recipient?: unknown } | null;
  const recipient = typeof payload?.recipient === 'string' ? normalizeLoginEmail(payload.recipient) : null;
  if (!recipient?.endsWith('@example.test')) return c.body(null, 404);
  const advanced = await withDb(async (db) => db.execute(sql`
    UPDATE customer_recovery_attempts AS attempt
       SET hold_started_at = now() - interval '2 seconds',
           hold_until = now() - interval '1 second'
      FROM customer_credentials AS credential
     WHERE credential.customer_id = attempt.customer_id
       AND credential.login_email = ${recipient}
       AND attempt.status = 'security_hold'
  `));
  return c.json({ accepted: Number(advanced.rowCount ?? 0) === 1 }, 200, { 'Cache-Control': 'no-store' });
});
app.post('/__test/password-hash-check', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) {
    return c.body(null, 404);
  }
  const payload = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  if (typeof payload?.email !== 'string' || typeof payload.password !== 'string') {
    return c.body(null, 400);
  }
  const matches = await withDb(async (db) => {
    const email = normalizeLoginEmail(payload.email as string);
    if (!email) return false;
    const credential = await new CustomerCredentialRepository(db).findByLoginEmail(email);
    return Boolean(
      credential?.loginEmailVerifiedAt &&
        (await hasher.verify(
          normalizePassword(payload.password as string),
          credential.passwordHash,
        )),
    );
  });
  return c.body(null, matches ? 204 : 401);
});

app.post('/__test/reset-login-budget', (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) {
    return c.body(null, 404);
  }
  for (const key of budgets.keys()) {
    if (key.startsWith('customer-email:login:')) budgets.delete(key);
  }
  return c.body(null, 204);
});

app.get('/__test/customer-session-status', async (c) => {
  if (c.req.header('x-customer-auth-r5-fixture') !== fixtureToken) {
    return c.body(null, 404);
  }
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return c.body(null, 401);
  const active = await withDb(async (db) =>
    Boolean(await new CustomerSessionService(db, config.session).authenticateSessionToken(token)),
  );
  return c.body(null, active ? 204 : 401);
});

app.route('/api/v1/customer-auth', emailAuth);
app.route('/api/v1/customer-session', lifecycle);
app.route('/api/v1/customer-recovery', recoveryRoutes);
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
