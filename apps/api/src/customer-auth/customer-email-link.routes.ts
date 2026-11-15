import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  emailRegistrationCompleteSchema,
  emailRegistrationRequestSchema,
  limitEmailAuthRequest,
  type IsolatedEmailAuthDependencies,
} from './customer-email-auth.routes';
import type { CustomerSessionService } from './customer-session.service';
import type { createCustomerEmailLinkService } from './customer-email-link.service';

/** Isolated composition. The application router does not mount these handlers. */
export function createIsolatedCustomerEmailLinkRoutes(config: {
  sessions: Pick<CustomerSessionService, 'authenticateSessionToken'>;
  link: ReturnType<typeof createCustomerEmailLinkService>;
  limiter: Pick<IsolatedEmailAuthDependencies, 'resolveTrustedSource' | 'keyForIdentifier' | 'limit'>;
}) {
  const router = new Hono();
  const response = (status: number) => new Response(null, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
  const owner = async (request: Request) => {
    const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token) return null;
    const identity = await config.sessions.authenticateSessionToken(token);
    return identity?.assurance === 'session'
      ? { customerId: identity.customerId, sessionId: identity.sessionId }
      : null;
  };
  router.use('*', bodyLimit({ maxSize: 8192, onError: () => response(413) }));
  router.onError(() => response(503));

  router.post('/email/link/request', async (c) => {
    const identity = await owner(c.req.raw);
    if (!identity) return response(401);
    const dto = emailRegistrationRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return response(400);
    const decision = await limitEmailAuthRequest(config.limiter, c.req.raw, 'delivery', dto.data.email);
    if (decision !== 'allowed') return response(decision === 'limited' ? 429 : 503);
    await config.link.requestProof(identity, dto.data.email).catch(() => undefined);
    return response(202);
  });

  router.post('/email/link/complete', async (c) => {
    const identity = await owner(c.req.raw);
    if (!identity) return response(401);
    const dto = emailRegistrationCompleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return response(400);
    // Completion verifies an existing password or hashes the first one. It
    // shares the approved password-work budget with verified email login.
    const decision = await limitEmailAuthRequest(config.limiter, c.req.raw, 'login', dto.data.email);
    if (decision !== 'allowed') return response(decision === 'limited' ? 429 : 503);
    return response(await config.link.complete(identity, dto.data) ? 204 : 401);
  });
  return router;
}
