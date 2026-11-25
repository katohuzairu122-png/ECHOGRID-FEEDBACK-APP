import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { requireCommunityPlatformPermission } from './community-permissions';
import { CommunityPilotEligibilityService } from '../community/community-pilot-eligibility';

type Env = { Bindings: Bindings; Variables: AuthVariables & PlatformVariables & AuditVariables };

/** Platform-admin only. Customers, businesses, cashiers and non-admin platform roles can never change eligibility. */
export const platformCommunityPilotRoutes = new Hono<Env>();
platformCommunityPilotRoutes.use('*', authenticate, requirePlatformRole(['admin']), requireCommunityPlatformPermission('community:pilot'));

const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const customerIdOf = (c: Context<Env>) => {
  const parsed = z.uuid().safeParse(c.req.param('customerId'));
  if (!parsed.success) throw new AppError('Invalid customer id.', 400, 'VALIDATION_ERROR');
  return parsed.data;
};
const auditContext = (c: Context<Env>) => ({
  actorUserId: c.get('userId') as string,
  ipAddress: c.req.header('cf-connecting-ip') ?? null,
  userAgent: c.req.header('user-agent') ?? null,
});

async function withService<T>(c: Context<Env>, fn: (service: CommunityPilotEligibilityService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(new CommunityPilotEligibilityService(db));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

platformCommunityPilotRoutes.get('/:customerId', async (c) => {
  const id = customerIdOf(c);
  return ok(c, await withService(c, (s) => s.status(id)));
});

for (const action of ['grant', 'revoke'] as const) {
  platformCommunityPilotRoutes.post(`/:customerId/${action}`, async (c) => {
    const id = customerIdOf(c);
    const body = await parseJsonBody(c.req.raw, reasonSchema);
    const result = await withService(c, (s) => s[action](id, body.reason, auditContext(c)));
    c.set('auditAlreadyRecorded', true);
    return ok(c, result);
  });
}
