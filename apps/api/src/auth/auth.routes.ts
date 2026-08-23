import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { AuthService } from './auth.service';
import { createDurableObjectPbkdf2Worker } from './pbkdf2-worker';
import {
  signupSchema,
  loginSchema,
  refreshSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  changePasswordSchema,
} from './auth.dto';
import { createEmailService } from '../notifications/email.service';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { rateLimit } from '../middleware/rate-limit';
import { authenticate, type AuthVariables } from '../middleware/authenticate';

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

/**
 * Builds a request-scoped AuthService: a fresh DB connection + repositories
 * for this request only, closed via waitUntil once the handler is done.
 */
async function withAuthService<T>(
  c: Context<{ Bindings: Bindings; Variables: AuthVariables }>,
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
      // Same environment-gated factory the notifications module uses, so
      // reset emails log to the console in dev/staging instead of spending
      // real Resend quota -- and, more importantly, so a developer can read
      // the reset link straight out of `wrangler dev` output.
      email: createEmailService(c.env.ENVIRONMENT, {
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

// signup/login carry the strict AUTH_RATE_LIMITER on top of the API-wide
// limiter applied in index.ts -- the brute-force protection flagged as
// missing since Block 5. Validation and error handling are no longer
// hand-rolled per route: parseJsonBody throws on bad input, AuthError
// (now an AppError) flows to the global handler, both land in the same
// response envelope automatically.

authRoutes.post('/signup', rateLimit('AUTH_RATE_LIMITER'), async (c) => {
  const body = await parseJsonBody(c.req.raw, signupSchema);
  const tokens = await withAuthService(c, (service) => service.signup(body));
  return ok(c, tokens, 201);
});

authRoutes.post('/login', rateLimit('AUTH_RATE_LIMITER'), async (c) => {
  const body = await parseJsonBody(c.req.raw, loginSchema);
  const tokens = await withAuthService(c, (service) =>
    service.login({
      ...body,
      userAgent: c.req.header('user-agent'),
      ipAddress: c.req.header('cf-connecting-ip'),
    }),
  );
  return ok(c, tokens);
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
authRoutes.post('/password-reset/request', rateLimit('AUTH_RATE_LIMITER'), async (c) => {
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
authRoutes.post('/password-reset/confirm', rateLimit('AUTH_RATE_LIMITER'), async (c) => {
  const body = await parseJsonBody(c.req.raw, resetPasswordSchema);
  await withAuthService(c, (service) =>
    service.resetPassword({ token: body.token, newPassword: body.newPassword }),
  );
  return c.body(null, 204);
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
authRoutes.post('/password/change', authenticate, async (c) => {
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
      platformRole: user.platformRole,
      impersonatedBy: c.get('impersonatedBy') ?? null,
    });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
