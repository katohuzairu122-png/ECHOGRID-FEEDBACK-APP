import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { AuthService } from './auth.service';
import { createDurableObjectPbkdf2Worker } from './pbkdf2-worker';
import { signupSchema, loginSchema, refreshSchema } from './auth.dto';
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
