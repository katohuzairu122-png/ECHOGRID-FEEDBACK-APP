import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { AuthService } from './auth.service';
import { CashierAuthService } from './cashier-auth.service';
import { createDurableObjectPbkdf2Worker } from './pbkdf2-worker';
import {
  signupSchema,
  loginSchema,
  cashierLoginSchema,
  managedCashierLoginSchema,
  cashierSwitchSchema,
  cashierSessionSchema,
  refreshSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  changePasswordSchema,
  updateProfileSchema,
} from './auth.dto';
import { createAccountSecurityEmailService } from '../notifications/email.service';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import {
  cashierAuthRateLimit,
  managedCashierLoginRateLimit,
  passwordChangeRateLimit,
  passwordResetConfirmRateLimit,
  passwordResetRequestRateLimit,
  signupRateLimit,
  staffLoginRateLimit,
} from '../middleware/rate-limit';
import { resolveClient } from '../lib/client-attribution';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import type { AuditVariables } from '../middleware/audit';

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: AuthVariables & AuditVariables }>();

/**
 * Builds a request-scoped AuthService: a fresh DB connection + repositories
 * for this request only, closed via waitUntil once the handler is done.
 */
async function withAuthService<T>(
  c: Context<{ Bindings: Bindings; Variables: AuthVariables & AuditVariables }>,
  fn: (service: AuthService) => Promise<T>,
): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  const repos = createRepositories(db);
  const service = new AuthService(
    repos,
    {
      JWT_ACCESS_SECRET: c.env.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: c.env.JWT_REFRESH_SECRET,
    },
    createDurableObjectPbkdf2Worker(c.env.PASSWORD_HASHER),
    {
      // Real Resend delivery on staging and production; console-only in
      // development so the reset link is readable in `wrangler dev` output.
      // See createAccountSecurityEmailService for why staging differs from
      // the notifications factory.
      email: createAccountSecurityEmailService(c.env.ENVIRONMENT, {
        apiKey: c.env.RESEND_API_KEY,
        fromAddress: c.env.RESEND_FROM_ADDRESS,
      }),
      webBaseUrl: c.env.WEB_BASE_URL,
    },
  );
  try {
    return await fn(service);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

/** Request-scoped CashierAuthService (same connection and secrets handling as withAuthService). */
async function withCashierService<T>(
  c: Context<{ Bindings: Bindings; Variables: AuthVariables & AuditVariables }>,
  fn: (service: CashierAuthService) => Promise<T>,
): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  const service = new CashierAuthService(
    createRepositories(db),
    { JWT_ACCESS_SECRET: c.env.JWT_ACCESS_SECRET, JWT_REFRESH_SECRET: c.env.JWT_REFRESH_SECRET },
    createDurableObjectPbkdf2Worker(c.env.PASSWORD_HASHER),
  );
  try {
    return await fn(service);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

// signup/login carry the strict AUTH_RATE_LIMITER on top of the API-wide
// limiter applied in index.ts -- the brute-force protection flagged as
// missing since Block 5. Validation and error handling are no longer
// hand-rolled per route: parseJsonBody throws on bad input, AuthError
// (now an AppError) flows to the global handler, both land in the same
// response envelope automatically.

authRoutes.post('/signup', signupRateLimit(), async (c) => {
  const body = await parseJsonBody(c.req.raw, signupSchema);
  const tokens = await withAuthService(c, (service) => service.signup(body));
  return ok(c, tokens, 201);
});

authRoutes.post('/login', staffLoginRateLimit(), async (c) => {
  const body = await parseJsonBody(c.req.raw, loginSchema);
  // STG-SEC-02B: the signed real client (when the web Worker forwarded one) is what the session row records; otherwise the
  // edge values, exactly as before.
  const client = await resolveClient(
    c.req.raw.headers,
    c.env.CLIENT_ATTRIBUTION_SECRET,
    Date.now(),
    c.env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS,
  );
  const tokens = await withAuthService(c, (service) =>
    service.login({
      ...body,
      userAgent: client.userAgent,
      ipAddress: client.ip,
    }),
  );
  return ok(c, tokens);
});

/**
 * CASHIER-PWA-01 C3: independent cashier sessions. These endpoints take credentials or a cashier refresh token in
 * the body (like /login and /refresh) and never a bearer token, so they are outside the cashier route allow-list on
 * purpose: a cashier access token cannot call them. Each records an audit entry attributed to the staff user and
 * visible in the business's own audit log.
 */
authRoutes.post('/cashier/login', cashierAuthRateLimit('login'), async (c) => {
  const body = await parseJsonBody(c.req.raw, cashierLoginSchema);
  const client = await resolveClient(c.req.raw.headers, c.env.CLIENT_ATTRIBUTION_SECRET, Date.now(), c.env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS);
  const result = await withCashierService(c, (service) =>
    service.login({
      ...body,
      userAgent: client.userAgent,
      ipAddress: client.ip,
    }),
  );
  c.set('userId', result.userId);
  if (result.status === 'authenticated') {
    c.set('auditMetadata', {
      action: 'auth.cashier_login',
      entityType: 'session',
      businessId: result.session.businessId,
      details: { branchId: result.session.branchId, deviceLabel: result.session.deviceLabel },
    });
  } else {
    // SEC-CASHIER-R2 F9: the first step of a two-step sign-in is recorded too. Business-scoped only when every choice is one business.
    const businesses = new Set(result.choices.map((choice) => choice.businessId));
    c.set('auditMetadata', {
      action: 'auth.cashier_selection_required',
      entityType: 'session',
      ...(businesses.size === 1 ? { businessId: [...businesses][0]! } : {}),
      details: { choices: result.choices.length },
    });
  }
  const { userId: _userId, ...publicResult } = result;
  return ok(c, publicResult);
});

/**
 * CASHIER-AUTH-02A: business-managed cashier sign-in (business code + username + password; no email). Same response shape and
 * session machinery as /cashier/login, so everything after it (refresh, logout, allow-list, revocation) is unchanged.
 */
authRoutes.post('/cashier/managed-login', managedCashierLoginRateLimit(), async (c) => {
  const body = await parseJsonBody(c.req.raw, managedCashierLoginSchema);
  const client = await resolveClient(c.req.raw.headers, c.env.CLIENT_ATTRIBUTION_SECRET, Date.now(), c.env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS);
  const result = await withCashierService(c, (service) =>
    service.managedLogin({ ...body, userAgent: client.userAgent, ipAddress: client.ip }),
  );
  c.set('userId', result.userId);
  if (result.status === 'authenticated') {
    c.set('auditMetadata', {
      action: 'auth.cashier_login',
      entityType: 'session',
      businessId: result.session.businessId,
      details: { branchId: result.session.branchId, deviceLabel: result.session.deviceLabel, method: 'managed' },
    });
  } else {
    c.set('auditMetadata', {
      action: 'auth.cashier_selection_required',
      entityType: 'session',
      ...(result.choices.length > 0 ? { businessId: result.choices[0]!.businessId } : {}),
      details: { choices: result.choices.length, method: 'managed' },
    });
  }
  const { userId: _userId, ...publicResult } = result;
  return ok(c, publicResult);
});

authRoutes.post('/cashier/session', cashierAuthRateLimit('session'), async (c) => {
  const body = await parseJsonBody(c.req.raw, cashierSessionSchema);
  const client = await resolveClient(c.req.raw.headers, c.env.CLIENT_ATTRIBUTION_SECRET, Date.now(), c.env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS);
  const result = await withCashierService(c, (service) =>
    service.createSession({
      ...body,
      userAgent: client.userAgent,
      ipAddress: client.ip,
    }),
  );
  c.set('userId', result.userId);
  c.set('auditMetadata', {
    action: 'auth.cashier_login',
    entityType: 'session',
    businessId: result.session.businessId,
    details: { branchId: result.session.branchId, deviceLabel: result.session.deviceLabel },
  });
  const { userId: _userId, ...publicResult } = result;
  return ok(c, { status: 'authenticated', ...publicResult });
});

authRoutes.post('/cashier/refresh', cashierAuthRateLimit('refresh'), async (c) => {
  const body = await parseJsonBody(c.req.raw, refreshSchema);
  const result = await withCashierService(c, (service) => service.refresh(body.refreshToken));
  const { userId: _userId, ...publicResult } = result;
  return ok(c, publicResult);
});

/**
 * CASHIER-AUTH-02C: in-session branch switching for a managed cashier. Like refresh and logout it takes the session's own refresh
 * token in the body and never a bearer, so it is outside the cashier route allow-list on purpose (a cashier ACCESS token cannot
 * call it). The whole operation runs in ONE transaction: a failure anywhere (including the audit write) leaves the session as it was.
 * A refusal that had to revoke a session commits that revocation first and then answers the error.
 */
authRoutes.post('/cashier/switch-branch', cashierAuthRateLimit('switch'), async (c) => {
  const body = await parseJsonBody(c.req.raw, cashierSwitchSchema);
  const client = await resolveClient(c.req.raw.headers, c.env.CLIENT_ATTRIBUTION_SECRET, Date.now(), c.env.CLIENT_ATTRIBUTION_SECRET_PREVIOUS);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const outcome = await db.transaction((tx) =>
      new CashierAuthService(
        createRepositories(tx),
        { JWT_ACCESS_SECRET: c.env.JWT_ACCESS_SECRET, JWT_REFRESH_SECRET: c.env.JWT_REFRESH_SECRET },
        createDurableObjectPbkdf2Worker(c.env.PASSWORD_HASHER),
      ).switchBranch(
        { refreshToken: body.refreshToken, targetBranchId: body.branchId, fromBranchId: body.fromBranchId, userAgent: client.userAgent, ipAddress: client.ip },
        // The session is identified (signature, hash and stored row) before any authorization decision, so even a refusal is a
        // security event attributed to this cashier and business by the audit recorder.
        (identity) => {
          c.set('userId', identity.userId);
          c.set('cashier', { businessId: identity.businessId, branchId: identity.branchId });
        },
      ),
    );
    if (outcome.status === 'denied') throw outcome.error;
    // The switch audit row is written inside the transaction; nothing else is recorded for a success.
    c.set('auditAlreadyRecorded', true);
    if (outcome.status === 'unchanged') return ok(c, { switched: false, session: outcome.session });
    const { userId: _userId, status: _status, previousSessionId: _p, sessionId: _s, fromBranchId: _f, toBranchId: _t, ...publicResult } = outcome;
    return ok(c, { switched: true, ...publicResult });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/** CASHIER-AUTH-02C: the branches this session may switch to (advisory, read-only; every switch re-checks everything). */
authRoutes.post('/cashier/branches', cashierAuthRateLimit('branches'), async (c) => {
  const body = await parseJsonBody(c.req.raw, refreshSchema);
  return ok(c, await withCashierService(c, (service) => service.listBranches(body.refreshToken)));
});

authRoutes.post('/cashier/logout', cashierAuthRateLimit('logout'), async (c) => {
  const body = await parseJsonBody(c.req.raw, refreshSchema);
  const ended = await withCashierService(c, (service) => service.logout(body.refreshToken));
  if (ended) {
    c.set('userId', ended.userId);
    c.set('auditMetadata', { action: 'auth.cashier_logout', entityType: 'session', businessId: ended.businessId, details: { branchId: ended.branchId } });
  }
  return c.body(null, 204);
});

authRoutes.post('/refresh', async (c) => {
  const body = await parseJsonBody(c.req.raw, refreshSchema);
  const tokens = await withAuthService(c, (service) => service.refresh(body.refreshToken));
  return ok(c, tokens);
});

authRoutes.post('/logout', async (c) => {
  const body = await parseJsonBody(c.req.raw, refreshSchema);
  await withAuthService(c, (service) => service.logout(body.refreshToken));
  return c.body(null, 204);
});

/**
 * Step 1 of account recovery. Always answers 202, whether or not the email
 * matched an account -- see AuthService.requestPasswordReset for why any
 * distinguishable response makes this an account-enumeration oracle.
 *
 * Carries AUTH_RATE_LIMITER, the same strict limiter as login/signup, and
 * for a sharper reason than brute force: every accepted call sends a real
 * email. Unlimited, this endpoint is a free mail-bomb aimed at any address
 * an attacker knows, and it burns the platform's Resend quota doing it --
 * the same "this request costs real money" logic behind OTP_RATE_LIMITER.
 */
authRoutes.post('/password-reset/request', passwordResetRequestRateLimit(), async (c) => {
  const body = await parseJsonBody(c.req.raw, requestPasswordResetSchema);
  await withAuthService(c, (service) =>
    service.requestPasswordReset({
      email: body.email,
      ipAddress: c.req.header('cf-connecting-ip'),
    }),
  );
  // 202, not 200-with-a-body: the platform has accepted the request and will
  // send mail if warranted. Deliberately no payload -- there is nothing this
  // response can safely say about whether an account exists.
  return c.body(null, 202);
});

/**
 * Step 2 of account recovery. Rate-limited on the same limiter: the token is
 * unguessable, so this is not brute-force protection, it is a cap on the
 * PBKDF2 work an unauthenticated caller can force the Durable Object to do
 * by submitting reset attempts.
 *
 * Returns 204 rather than a fresh token pair. Every session is revoked as
 * part of the reset (AuthService.afterPasswordChanged), so the user re-logs
 * in with their new password -- issuing tokens here would hand a working
 * session to whoever redeemed the link without ever proving they can pass
 * the login they just enabled.
 */
authRoutes.post('/password-reset/confirm', passwordResetConfirmRateLimit(), async (c) => {
  const body = await parseJsonBody(c.req.raw, resetPasswordSchema);
  await withAuthService(c, (service) =>
    service.resetPassword({ token: body.token, newPassword: body.newPassword }),
  );
  return c.body(null, 204);
});

/**
 * Authenticated self-service profile update. Email changes require a
 * separate verification flow and are deliberately excluded here.
 */
authRoutes.patch('/me', authenticate, async (c) => {
  const body = await parseJsonBody(c.req.raw, updateProfileSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const user = await createRepositories(db).users.update(
      c.get('userId'),
      { fullName: body.fullName, phone: body.phone || null },
      c.get('userId'),
    );
    if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
    return ok(c, {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      platformRole: user.platformRole,
      impersonatedBy: c.get('impersonatedBy') ?? null,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Authenticated self-service password change -- the everyday counterpart to
 * the recovery flow above, and the reason a user who merely *suspects*
 * compromise no longer has to go through email to rotate a credential.
 *
 * Also revokes every session, including the caller's own: the client must
 * re-authenticate afterwards. That is the correct trade -- a change made
 * because a password may be compromised is worthless if the compromised
 * session survives it.
 */
authRoutes.post('/password/change', authenticate, passwordChangeRateLimit(), async (c) => {
  const body = await parseJsonBody(c.req.raw, changePasswordSchema);
  await withAuthService(c, (service) =>
    service.changePassword({
      userId: c.get('userId'),
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    }),
  );
  return c.body(null, 204);
});

/**
 * The authenticated principal's own profile. Added in Platform Admin
 * Console Block 5 specifically so apps/web can learn platformRole client-
 * side (previously API-internal only, see db/schema/users.ts's
 * PLATFORM_ROLES comment) and decide whether to show the console entry
 * point -- but it's general-purpose, not platform-specific: any
 * authenticated user can call it, platformRole is simply null for the
 * overwhelming majority. Direct repository read, no service needed --
 * matches business.routes.ts's GET /:id/public precedent for a simple,
 * shape-only lookup.
 */
authRoutes.get('/me', authenticate, async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const user = await createRepositories(db).users.findById(c.get('userId'));
    if (!user) {
      throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
    }
    return ok(c, {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      platformRole: user.platformRole,
      impersonatedBy: c.get('impersonatedBy') ?? null,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
