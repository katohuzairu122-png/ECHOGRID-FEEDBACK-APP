import { Hono, type Context } from 'hono';
import { joinCommunitySchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import {
  customerAuthenticate,
  type CustomerAuthVariables,
} from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { CommunityMembershipService } from './community-membership.service';
import { CommunityPointAwardService } from './community-point-award.service';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

export const communityCustomerRoutes = new Hono<Env>();

communityCustomerRoutes.use('*', customerAuthenticate, rateLimit('PUBLIC_RATE_LIMITER'));

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

function serializeMembership(
  row: Awaited<ReturnType<CommunityMembershipService['getStatus']>>['membership'],
) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customerId,
    status: row.status,
    policyVersion: row.policyVersion,
    joinedAt: row.joinedAt.toISOString(),
    leftAt: row.leftAt?.toISOString() ?? null,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeAccount(
  row: Awaited<ReturnType<CommunityMembershipService['getStatus']>>['account'],
) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customerId,
    status: row.status,
    pointsBalance: row.pointsBalance,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

communityCustomerRoutes.get('/', async (c) =>
  withDb(c, async (db) => {
    const status = await new CommunityMembershipService(db).getStatus(c.get('customerId'));
    return ok(c, {
      membership: serializeMembership(status.membership),
      account: serializeAccount(status.account),
    });
  }),
);

communityCustomerRoutes.post('/join', async (c) => {
  const body = await parseJsonBody(c.req.raw, joinCommunitySchema);
  return withDb(c, async (db) => {
    const result = await new CommunityMembershipService(db).join(
      c.get('customerId'),
      body.policyVersion,
    );
    const released = await new CommunityPointAwardService(db).reevaluatePendingMembership(
      c.get('customerId'),
    );
    return ok(
      c,
      {
        membership: serializeMembership(result.membership),
        account: serializeAccount(result.account),
        created: result.created,
        reactivated: result.reactivated,
        releasedPendingAwards: released.filter((award) => award.awarded).length,
      },
      result.created ? 201 : 200,
    );
  });
});

communityCustomerRoutes.post('/leave', async (c) =>
  withDb(c, async (db) => {
    const result = await new CommunityMembershipService(db).leave(c.get('customerId'));
    return ok(c, {
      membership: serializeMembership(result.membership),
      account: serializeAccount(result.account),
    });
  }),
);
