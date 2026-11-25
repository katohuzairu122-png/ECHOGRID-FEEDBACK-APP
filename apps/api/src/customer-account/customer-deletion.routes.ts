import { Hono } from 'hono';
import type { CustomerSessionService } from '../customer-auth/customer-session.service';
import { isStepUpFresh } from '../customer-auth/session-policy';
import type { CustomerDeletionRequestRepository } from '../repositories/customer-deletion-request.repository';
import type { AuditLogRepository } from '../repositories/audit-log.repository';

const noStore = { 'Cache-Control': 'no-store' };

export type CustomerDeletionDeps = {
  sessions: Pick<CustomerSessionService, 'authenticateSessionToken' | 'logoutAll'>;
  requests: Pick<CustomerDeletionRequestRepository, 'findPending' | 'fileOrGetPending' | 'cancelPending'>;
  audit: Pick<AuditLogRepository, 'record'>;
  /** Password reauthentication updates only the caller's live session step-up evidence. */
  reauthenticate: (customerId: string, sessionId: string, currentPassword: string) => Promise<boolean>;
  /** Shared fail-closed rate limit. */
  allowReauthentication: (customerId: string) => Promise<boolean>;
  stepUpWindowSeconds: number;
  clock?: () => Date;
};

/**
 * CUST-DEL-01: "Delete my account data" request. Three routes, all for a live customer session (a legacy token is refused:
 * filing needs a fresh step-up, which a legacy token can never prove). These routes handle their own authentication on purpose:
 * they must stay reachable while a deletion is pending, which the shared customer middleware blocks for everything else.
 * Nothing is erased here: the request only queues the account for the operator after the 30-day restore window.
 */
export function createCustomerDeletionRoutes(deps: CustomerDeletionDeps) {
  const router = new Hono();
  const now = () => (deps.clock ?? (() => new Date()))();
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });
  const identityOf = async (req: Request) => {
    const token = req.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token) return null;
    const identity = await deps.sessions.authenticateSessionToken(token);
    return identity?.assurance === 'session' ? identity : null;
  };
  const view = (r: { status: string; requestedAt: Date; scheduledFor: Date }) => ({
    status: r.status, requestedAt: r.requestedAt.toISOString(), scheduledFor: r.scheduledFor.toISOString(),
  });
  const audit = (customerId: string, action: string, metadata: Record<string, string>) =>
    deps.audit.record({ businessId: null, actorUserId: null, action, entityType: 'customer', entityId: customerId, metadata })
      .catch(() => undefined); // the audit trail describes the request; it must not fail it (same rule as middleware/audit.ts)

  router.post('/deletion/reauth', async (c) => {
    const who = await identityOf(c.req.raw);
    if (!who || who.authMethod !== 'password') return json({ error: 'Unauthorized' }, 401);
    if (Number(c.req.header('content-length') ?? '0') > 8192) return json({ error: 'Invalid request' }, 400);
    let input: unknown;
    try { input = await c.req.json(); } catch { return json({ error: 'Invalid request' }, 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'currentPassword') ||
        typeof (input as Record<string, unknown>).currentPassword !== 'string' ||
        !(input as { currentPassword: string }).currentPassword ||
        (input as { currentPassword: string }).currentPassword.length > 1024)
      return json({ error: 'Invalid request' }, 400);
    if (!(await deps.allowReauthentication(who.customerId))) return json({ error: 'Too many attempts' }, 429);
    const ok = await deps.reauthenticate(who.customerId, who.sessionId, (input as { currentPassword: string }).currentPassword);
    return ok ? new Response(null, { status: 204, headers: noStore }) :
      json({ error: 'Invalid credentials' }, 401);
  });

  router.get('/deletion', async (c) => {
    const who = await identityOf(c.req.raw);
    if (!who) return json({ error: 'Unauthorized' }, 401);
    const pending = await deps.requests.findPending(who.customerId);
    return json(pending ? view(pending) : { status: 'none' });
  });

  router.post('/deletion', async (c) => {
    const who = await identityOf(c.req.raw);
    if (!who) return json({ error: 'Unauthorized' }, 401);
    if (!isStepUpFresh(who.stepUpVerifiedAt, now(), deps.stepUpWindowSeconds)) {
      return json({ error: 'Please confirm it is you, then try again.', code: 'STEP_UP_REQUIRED' }, 403);
    }
    const { request, created } = await deps.requests.fileOrGetPending(who.customerId, now());
    if (created) {
      // Sign every device out. The account stays signed-in-able: the next sign-in lands on the restore screen.
      await deps.sessions.logoutAll({ customerId: who.customerId });
      await audit(who.customerId, 'customer.deletion_requested', { scheduledFor: request.scheduledFor.toISOString() });
    }
    return json(view(request), created ? 201 : 200);
  });

  router.post('/deletion/restore', async (c) => {
    const who = await identityOf(c.req.raw);
    if (!who) return json({ error: 'Unauthorized' }, 401);
    const cancelled = await deps.requests.cancelPending(who.customerId, now());
    if (!cancelled) return json({ error: 'No deletion is pending.', code: 'NO_PENDING_DELETION' }, 404);
    await audit(who.customerId, 'customer.deletion_restored', {});
    return json({ status: 'restored' });
  });

  router.onError(() => json({ error: 'Service unavailable' }, 503));
  return router;
}
