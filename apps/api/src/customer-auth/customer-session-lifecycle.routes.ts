import { Hono } from 'hono';
import type { CustomerSessionService } from './customer-session.service';
import { isWellFormedRefreshCredential } from './session-tokens';

/** An unmounted lifecycle router for development composition. */
export function createCustomerSessionLifecycleRoutes(
  sessions: Pick<CustomerSessionService, 'refresh' | 'authenticateSessionToken' | 'revokeSession' | 'logoutAll'>,
) {
  const router = new Hono();
  const reject = () => Response.json({ error: 'Invalid customer credentials' }, {
    status: 401, headers: { 'Cache-Control': 'no-store' },
  });
  router.post('/refresh', async (c) => {
    const credential = c.req.header('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!isWellFormedRefreshCredential(credential)) return reject();
    const result = await sessions.refresh(credential);
    if (!result.ok) {
      return result.kind === 'conflict' ? c.body(null, 409, { 'Cache-Control': 'no-store' }) : reject();
    }
    const { accessToken, accessExpiresAt, refreshCredential, refreshExpiresAt } = result.session;
    return c.json({ accessToken, accessExpiresAt, refreshCredential, refreshExpiresAt }, 200, {
      'Cache-Control': 'no-store',
    });
  });
  router.post('/logout', async (c) => {
    const credential = c.req.header('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!credential) return reject();
    const identity = await sessions.authenticateSessionToken(credential);
    if (!identity || identity.assurance !== 'session') return reject();
    await sessions.revokeSession({ customerId: identity.customerId, sessionId: identity.sessionId });
    return c.body(null, 204, { 'Cache-Control': 'no-store' });
  });
  router.post('/logout-all', async (c) => {
    const credential = c.req.header('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!credential) return reject();
    const identity = await sessions.authenticateSessionToken(credential);
    if (!identity || identity.assurance !== 'session') return reject();
    await sessions.logoutAll({ customerId: identity.customerId });
    return c.body(null, 204, { 'Cache-Control': 'no-store' });
  });
  router.onError(() => Response.json({ error: 'Service unavailable' }, {
    status: 503, headers: { 'Cache-Control': 'no-store' },
  }));
  return router;
}
