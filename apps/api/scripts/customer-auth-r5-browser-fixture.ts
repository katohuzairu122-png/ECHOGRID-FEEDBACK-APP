import { createServer } from 'node:http';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { buildDb } from '../src/db/client';
import { createDirectPbkdf2Worker } from '../src/auth/pbkdf2-worker';
import { createCustomerEmailTrustedSource } from '../src/customer-auth/customer-email-trusted-source';
import { CustomerAuthService } from '../src/customer-auth/customer-auth.service';
import { TwilioVerifyService } from '../src/customer-auth/twilio-verify.service';
import { customerAuthRoutes } from '../src/customer-auth/customer-auth.routes';
import { loyaltyCustomerRoutes } from '../src/loyalty/loyalty-customer.routes';
import { customerMembershipRoutes } from '../src/customer-relationships/customer-membership.routes';
import { qrRoutes } from '../src/qr/qr.routes';
import { businessRoutes } from '../src/businesses/business.routes';
import { signQrToken } from '../src/qr/qr-token';
import { decode, sign } from 'hono/jwt';
import { signCustomerSessionAccessToken } from '../src/customer-auth/session-tokens';
import { createCustomerRecoveryCodeService } from '../src/customer-auth/customer-recovery-code.service';
import { createRecoveryCodeManagementLimiter } from '../src/customer-auth/customer-recovery-code-management';
import { createRepositories } from '../src/repositories';
import { errorHandler } from '../src/lib/error-handler';
import { createCustomerEmailLinkService } from '../src/customer-auth/customer-email-link.service';
import { createCustomerEmailLinkComposition } from '../src/customer-auth/customer-email-link.composition';
import { createEmailLinkProofDelivery } from '../src/customer-auth/customer-email-auth.delivery';
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
import { createCustomerDeletionComposition } from '../src/customer-account/customer-deletion.composition';
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
const qrSecret = process.env.QR_TOKEN_SECRET;
const fraudSalt = process.env.FRAUD_DETECTION_SALT;

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
  !qrSecret ||
  !fraudSalt ||
  [fixtureToken, attributionSecret, hmacSecret, sessionSecret, legacySecret, recoverySecret, qrSecret, fraudSalt].some(
    (value) => Buffer.byteLength(value) < 32,
  )
) {
  throw new Error('Customer-auth R5 fixture requires isolated CI PostgreSQL and per-run secrets.');
}

const mailboxes = new Map<string, EmailMessage[]>();
const budgets = new Map<string, { count: number; resetsAt: number }>();
const velocityState = new Map<string, { value: string; expiresAt: number }>();
const velocityKv = {
  async get(key: string) {
    const entry = velocityState.get(key);
    return entry && entry.expiresAt > Date.now() ? entry.value : null;
  },
  async put(key: string, value: string, options: { expirationTtl: number }) {
    velocityState.set(key, { value, expiresAt: Date.now() + options.expirationTtl * 1000 });
  },
};
const recoveryPhoneCodes = new Map<string, string>();
const syntheticTwilioVerifications = new Map<string, { code: string; expiresAt: number }>();
const legacyOtpDiagnostics: string[] = [];
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://verify.twilio.com/v2/Services/')) return originalFetch(input, init);
  const form = init?.body instanceof URLSearchParams
    ? new URLSearchParams(init.body)
    : new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
  const phone = form.get('To') ?? '';
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) return Response.json({ code: 60200 }, { status: 400 });
  if (url.endsWith('/Verifications')) {
    syntheticTwilioVerifications.set(phone, { code: '123456', expiresAt: Date.now() + 600_000 });
    legacyOtpDiagnostics.push('provider_request_accepted');
    return Response.json({ status: 'pending' });
  }
  if (url.endsWith('/VerificationCheck')) {
    const active = syntheticTwilioVerifications.get(phone);
    const approved = Boolean(active && active.expiresAt > Date.now() && active.code === form.get('Code'));
    if (approved) syntheticTwilioVerifications.delete(phone);
    legacyOtpDiagnostics.push(approved ? 'provider_proof_approved' : 'provider_proof_denied');
    return Response.json({ status: approved ? 'approved' : 'pending' });
  }
  return Response.json({ code: 20404 }, { status: 404 });
};
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
      legacyOtpSession: async (phone, code) => withDb(async (db) => {
        const provider = new TwilioVerifyService({
          accountSid: 'AC_SYNTHETIC_CUSTOMER_AUTH_TEST',
          authToken: 'synthetic-test-provider-token-never-live',
          serviceSid: 'VA_SYNTHETIC_CUSTOMER_AUTH_TEST',
        });
        const auth = new CustomerAuthService(
          createRepositories(db),
          { async send() {} },
          { CUSTOMER_JWT_SECRET: legacySecret },
          hasher,
        );
        try {
          if (!await provider.check(phone, code)) {
            legacyOtpDiagnostics.push('legacy_proof_rejected');
            return null;
          }
          const customer = await auth.completeVerifiedPhoneForRotatingSession(phone);
          legacyOtpDiagnostics.push('legacy_identity_resolved');
          const established = await new CustomerSessionService(db, config.session).establishSession({
            customerId: customer.id,
            authMethod: 'otp',
          });
          legacyOtpDiagnostics.push(established.ok ? 'legacy_session_established' : `legacy_session_denied:${established.reason}`);
          return established.ok ? established.session : null;
        } catch (error) {
          const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : error instanceof Error ? error.name : 'UnknownError';
          legacyOtpDiagnostics.push(`legacy_exception:${code}`);
          throw error;
        }
      }),
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

const deletionRoutes = createCustomerDeletionComposition({
  isEnabled: (ctx) => ctx.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true' &&
    ctx.env.CUSTOMER_DELETION_ENABLED === 'true',
  async open() {
    const client = new Client({ connectionString });
    await client.connect();
    const db = buildDb(client);
    const sessions = new CustomerSessionService(db, config.session);
    const passwordAuth = new CustomerPasswordAuthService(db, sessions, hasher, {
      passwordMinLength: config.passwordMinLength,
      phoneProofMaxAgeSeconds: 300,
    });
    return {
      deps: {
        sessions,
        requests: createRepositories(db).customerDeletionRequests,
        audit: createRepositories(db).auditLog,
        stepUpWindowSeconds: session.stepUpWindowSeconds,
        reauthenticate: (customerId: string, sessionId: string, currentPassword: string) =>
          passwordAuth.reauthenticateSession({ customerId, sessionId, currentPassword }),
        allowReauthentication: (customerId: string) =>
          testLimiter({ key: `customer-deletion:reauth:${customerId}`, limit: 5, windowSeconds: 900 }),
      },
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
    const recoveryCodes = createCustomerRecoveryCodeService({ db, hmacSecret: recoverySecret, stepUpWindowSeconds: session.stepUpWindowSeconds });
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
          allow: createRecoveryCodeManagementLimiter(recoverySecret, testLimiter),
          issue: (owner) => recoveryCodes.issue(owner),
          revoke: (owner) => recoveryCodes.revoke(owner),
        },
      },
      close: () => client.end(),
    };
  },
});

const emailLinkRoutes = createCustomerEmailLinkComposition({
  isEnabled: () => true,
  async open() {
    const client = new Client({ connectionString });
    await client.connect();
    const db = buildDb(client);
    return {
      dependencies: {
        sessions: new CustomerSessionService(db, config.session),
        link: createCustomerEmailLinkService({
          db,
          hmacSecret,
          hasher,
          passwordPolicy: { minLength: config.passwordMinLength },
          deliver: createEmailLinkProofDelivery({ email: emailSink, webBaseUrl: config.webBaseUrl }),
        }),
        limiter: {
          resolveTrustedSource,
          keyForIdentifier: (address: string) => customerChallengeDigest({
            secret: hmacSecret,
            purpose: 'email_link',
            field: 'subject',
            value: normalizeLoginEmail(address) ?? address,
          }),
          limit: testLimiter,
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
app.get('/__test/legacy-otp-diagnostics', (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  return c.json({ events: legacyOtpDiagnostics.slice(-12) }, 200, { 'Cache-Control': 'no-store' });
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
  const stored = await withDb(db => db.$client.query<{ phone: string }>(
    'SELECT c.phone FROM customers c JOIN customer_credentials cc ON cc.customer_id=c.id WHERE cc.login_email=$1', [recipient],
  ));
  return c.json({ accepted: true, phone: stored.rows[0]?.phone }, 200, { 'Cache-Control': 'no-store' });
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
app.post('/__test/reset-acceptance-budgets', (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  budgets.clear();
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
app.post('/__test/seed-legacy-customer', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  const payload = (await c.req.json().catch(() => null)) as { phone?: unknown } | null;
  const phone = typeof payload?.phone === 'string' ? payload.phone : '';
  if (!/^\+1555[0-9]{7}$/.test(phone)) return c.body(null, 404);
  const result = await withDb(async (db) => {
    const { customer } = await new CustomerRepository(db).createIfAbsent({ phone, phoneVerifiedAt: new Date() });
    if (!customer) throw new Error('Synthetic legacy identity could not be created.');
    const slug = `r5-legacy-${phone.slice(-7)}`;
    const business = await db.$client.query<{ id: string }>(
      'INSERT INTO businesses (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id',
      ['Synthetic R5 Legacy Business', slug],
    );
    const businessId = business.rows[0]?.id;
    if (!businessId) throw new Error('Synthetic business could not be created.');
    const membership = await db.$client.query<{ id: string }>(
      `INSERT INTO business_customer_memberships (customer_id, business_id, status, onboarding_source)
       VALUES ($1, $2, 'active', 'legacy_migration')
       ON CONFLICT (customer_id, business_id) DO UPDATE SET status='active' RETURNING id`,
      [customer.id, businessId],
    );
    const membershipId = membership.rows[0]?.id;
    if (!membershipId) throw new Error('Synthetic membership could not be created.');
    await db.$client.query(
      `INSERT INTO loyalty_accounts (customer_id, business_id, membership_id, points)
       VALUES ($1, $2, $3, 42)
       ON CONFLICT (customer_id, business_id) DO UPDATE SET membership_id=EXCLUDED.membership_id, points=42`,
      [customer.id, businessId, membershipId],
    );
    return { customerId: customer.id };
  });
  return c.json(result, 200, { 'Cache-Control': 'no-store' });
});
app.get('/__test/legacy-customer-snapshot', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  const phone = c.req.query('phone') ?? '';
  if (!/^\+1555[0-9]{7}$/.test(phone)) return c.body(null, 404);
  const snapshot = await withDb(async (db) => {
    const { rows } = await db.$client.query(
      `SELECT c.id, c.full_name AS "fullName", cc.login_email AS email,
              (SELECT count(*)::int FROM business_customer_memberships m WHERE m.customer_id=c.id) AS memberships,
              (SELECT COALESCE(sum(a.points), 0)::int FROM loyalty_accounts a WHERE a.customer_id=c.id) AS points
         FROM customers c LEFT JOIN customer_credentials cc ON cc.customer_id=c.id WHERE c.phone=$1`,
      [phone],
    );
    return rows[0] ?? null;
  });
  return c.json({ customer: snapshot }, 200, { 'Cache-Control': 'no-store' });
});

// The following helpers exist only in this loopback/CI/database-name guarded
// process. They never mount in the application, and never accept live identities.
app.post('/__test/seed-qr-context', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  const contexts = await withDb(async (db) => {
    const create = async (label: string) => {
      const slug = `r5-qr-${crypto.randomUUID()}`;
      const business = (await db.$client.query<{ id: string }>(
        'INSERT INTO businesses (name,slug) VALUES ($1,$2) RETURNING id', [`Synthetic ${label}`, slug],
      )).rows[0]!;
      const branch = (await db.$client.query<{ id: string }>(
        'INSERT INTO branches (business_id,name,slug) VALUES ($1,$2,$3) RETURNING id', [business.id, `Synthetic ${label} branch`, slug],
      )).rows[0]!;
      const qr = (await db.$client.query<{ id: string }>(
        'INSERT INTO qr_codes (business_id,branch_id) VALUES ($1,$2) RETURNING id', [business.id, branch.id],
      )).rows[0]!;
      const token = await signQrToken({ qrCodeId: qr.id, businessId: business.id, branchId: branch.id }, qrSecret);
      return { businessId: business.id, branchId: branch.id, qrId: qr.id, token };
    };
    const a = await create('acceptance A'); const b = await create('acceptance B');
    const payload = decode(a.token).payload;
    return { a, b, expired: await sign({ ...payload, iat: Math.floor(Date.now() / 1000) - 3600, exp: Math.floor(Date.now() / 1000) - 1 }, qrSecret),
      foreignScope: await sign({ ...payload, businessId: b.businessId, branchId: b.branchId }, qrSecret),
      legacy: await sign({ ...payload, type: 'qr_feedback' }, qrSecret) };
  });
  return c.json(contexts, 200, { 'Cache-Control': 'no-store' });
});
app.post('/__test/revoke-qr', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  const input = await c.req.json<{ qrId?: string }>();
  if (!/^[0-9a-f-]{36}$/.test(input.qrId ?? '')) return c.body(null, 400);
  await withDb(db => db.$client.query(`UPDATE qr_codes SET status='revoked' WHERE id=$1 AND business_id IN
    (SELECT id FROM businesses WHERE slug LIKE 'r5-qr-%')`, [input.qrId]));
  return c.body(null, 204);
});
app.post('/__test/acceptance-clock', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  const input = await c.req.json<{ recipient?: string; kind?: string }>();
  const recipient = normalizeLoginEmail(input.recipient);
  if (!recipient?.endsWith('@example.test')) return c.body(null, 404);
  const result = await withDb(async db => {
    if (input.kind === 'registration') {
      const digest = await customerChallengeDigest({ secret: hmacSecret, purpose: 'email_registration', field: 'subject', value: recipient });
      await db.$client.query(`UPDATE customer_auth_challenges SET created_at=now()-interval '20 minutes', expires_at=now()-interval '1 second'
        WHERE purpose='email_registration' AND subject_digest=$1 AND consumed_at IS NULL`, [digest]);
      return {};
    }
    const customer = (await db.$client.query<{ customer_id: string }>(
      'SELECT customer_id FROM customer_credentials WHERE login_email=$1', [recipient],
    )).rows[0];
    if (!customer) return null;
    if (input.kind === 'recovery-email-cooldown') {
      // Move only this synthetic account's delivery timestamps past the real
      // 60-second resend budget. Do not restore consumed or expired proofs.
      await db.$client.query(`UPDATE customer_auth_challenges SET created_at=now()-interval '61 seconds'
        WHERE customer_id=$1 AND purpose='email_recovery'`, [customer.customer_id]);
      return {};
    }
    if (input.kind === 'access') {
      const row = (await db.$client.query<{ id: string }>(
        'SELECT id FROM customer_sessions WHERE customer_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [customer.customer_id],
      )).rows[0];
      return row ? { accessToken: await signCustomerSessionAccessToken(customer.customer_id, row.id, sessionSecret,
        { ttlSeconds: 900, nowSeconds: Math.floor(Date.now() / 1000) - 3600 }) } : null;
    }
    if (input.kind === 'idle') await db.$client.query(`UPDATE customer_sessions SET idle_expires_at=now()-interval '1 second' WHERE customer_id=$1`, [customer.customer_id]);
    else if (input.kind === 'absolute') await db.$client.query(`UPDATE customer_sessions SET absolute_expires_at=now()-interval '1 second', idle_expires_at=now()-interval '1 second' WHERE customer_id=$1`, [customer.customer_id]);
    else if (input.kind === 'refresh') await db.$client.query(`UPDATE customer_refresh_tokens SET expires_at=now()-interval '1 second' WHERE session_id IN (SELECT id FROM customer_sessions WHERE customer_id=$1)`, [customer.customer_id]);
    else if (input.kind === 'replay') await db.$client.query(`UPDATE customer_refresh_tokens SET rotated_at=now()-interval '20 seconds' WHERE rotated_at IS NOT NULL AND session_id IN (SELECT id FROM customer_sessions WHERE customer_id=$1)`, [customer.customer_id]);
    else return null;
    return {};
  });
  return result ? c.json(result, 200, { 'Cache-Control': 'no-store' }) : c.body(null, 400);
});
app.get('/__test/customer-effects', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${fixtureToken}`) return c.body(null, 404);
  const recipient = normalizeLoginEmail(c.req.query('recipient'));
  if (!recipient?.endsWith('@example.test')) return c.body(null, 404);
  const rows = await withDb(db => db.$client.query(`SELECT c.id,
    (SELECT count(*)::int FROM business_customer_memberships WHERE customer_id=c.id) AS memberships,
    (SELECT count(*)::int FROM consent_grants WHERE customer_id=c.id AND purpose='join_loyalty' AND status='active') AS consents,
    (SELECT count(*)::int FROM customer_onboarding_events WHERE customer_id=c.id) AS onboarding,
    (SELECT COALESCE(sum(points),0)::int FROM loyalty_accounts WHERE customer_id=c.id) AS points,
    (SELECT count(*)::int FROM loyalty_transactions WHERE loyalty_account_id IN (SELECT id FROM loyalty_accounts WHERE customer_id=c.id)) AS transactions,
    (SELECT count(*)::int FROM community_memberships WHERE customer_id=c.id) AS community
    FROM customers c JOIN customer_credentials cc ON cc.customer_id=c.id WHERE cc.login_email=$1`, [recipient]));
  return c.json(rows.rows[0] ?? null, 200, { 'Cache-Control': 'no-store' });
});

app.route('/api/v1/customer-auth', customerAuthRoutes);
app.route('/api/v1/customer-auth', emailLinkRoutes);
app.route('/api/v1/customer-auth', emailAuth);
app.route('/api/v1/customer-session', lifecycle);
app.route('/api/v1/customer-account', deletionRoutes);
app.route('/api/v1/customer-recovery', recoveryRoutes);
app.route('/api/v1/loyalty/me', loyaltyCustomerRoutes);
app.route('/api/v1/customer-memberships', customerMembershipRoutes);
app.route('/api/v1/qr', qrRoutes);
app.route('/api/v1/businesses', businessRoutes);
app.onError(errorHandler);

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
    const rateLimiter = { async limit() { return { success: true }; } };
    const response = await app.fetch(request, {
      ENVIRONMENT: 'production',
      HYPERDRIVE: { connectionString },
      PASSWORD_HASHER: { async fetch() { throw new Error('Unused synthetic hasher binding'); } },
      CUSTOMER_EMAIL_AUTH_ENABLED: 'true',
      CUSTOMER_DELETION_ENABLED: 'true',
      CUSTOMER_RECOVERY_ENABLED: 'true',
      CUSTOMER_EMAIL_AUTH_HMAC_SECRET: hmacSecret,
      CUSTOMER_SESSION_SIGNING_SECRET: sessionSecret,
      CUSTOMER_SESSION_ACCESS_TTL_SECONDS: '900',
      CUSTOMER_SESSION_REFRESH_TTL_SECONDS: '3600',
      CUSTOMER_SESSION_ABSOLUTE_TTL_SECONDS: '7200',
      CUSTOMER_SESSION_IDLE_TTL_SECONDS: '1800',
      CUSTOMER_STEP_UP_WINDOW_SECONDS: '600',
      CUSTOMER_PASSWORD_MIN_LENGTH: '8',
      CUSTOMER_JWT_SECRET: legacySecret,
      QR_TOKEN_SECRET: qrSecret,
      FRAUD_DETECTION_SALT: fraudSalt,
      CACHE: velocityKv,
      CUSTOMER_AUTH_RATE_LIMIT: rateLimiter,
      CUSTOMER_API_RATE_LIMITER: rateLimiter,
      PUBLIC_RATE_LIMITER: rateLimiter,
      OTP_RATE_LIMITER: rateLimiter,
      CLIENT_ATTRIBUTION_SECRET: attributionSecret,
      WEB_BASE_URL: 'http://localhost:3000',
      TWILIO_ACCOUNT_SID: 'AC_SYNTHETIC_CUSTOMER_AUTH_TEST',
      TWILIO_AUTH_TOKEN: 'synthetic-test-provider-token-never-live',
      TWILIO_FROM_NUMBER: '+15555550100',
      TWILIO_VERIFY_SERVICE_SID: 'VA_SYNTHETIC_CUSTOMER_AUTH_TEST',
    } as never, {
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
