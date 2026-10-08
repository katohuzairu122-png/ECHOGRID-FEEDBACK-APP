import { Hono, type Context } from 'hono';
import {
  communityPointAdminAdjustmentSchema,
  communityPointAdminReversalSchema,
  communityPointPlatformStateChangeSchema,
  type CommunityMembershipDto,
  type CommunityPointAccountDto,
  type CommunityPointTransactionDto,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import type {
  CommunityMembership,
  CommunityPointAccount,
  CommunityPointTransaction,
} from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import {
  requirePlatformRole,
  type PlatformVariables,
} from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { requireCommunityPlatformPermission } from './community-permissions';
import { CommunityPointAdminAdjustmentService } from '../community/community-point-admin-adjustment.service';
import { CommunityPlatformStateService } from '../community/community-platform-state.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables & AuditVariables;
};

export const platformCommunityPointAdjustmentRoutes = new Hono<Env>();

platformCommunityPointAdjustmentRoutes.use(
  '*',
  authenticate,
  requirePlatformRole(['support', 'billing', 'admin']),
  requireCommunityPlatformPermission('community:adjust'),
);

function auditContext(c: Context<Env>) {
  return {
    actorUserId: c.get('userId') as string,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
}

function serializeMembership(
  row: CommunityMembership,
): CommunityMembershipDto {
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

function serializeAccount(row: CommunityPointAccount): CommunityPointAccountDto {
  return {
    id: row.id,
    customerId: row.customerId,
    status: row.status,
    pointsBalance: row.pointsBalance,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeTransaction(
  row: CommunityPointTransaction,
): CommunityPointTransactionDto {
  return {
    id: row.id,
    accountId: row.accountId,
    customerId: row.customerId,
    type: row.type,
    points: row.points,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    ruleId: row.ruleId,
    awardDecisionId: row.awardDecisionId,
    businessId: row.businessId,
    branchId: row.branchId,
    reversalOf: row.reversalOf,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  };
}

platformCommunityPointAdjustmentRoutes.post(
  '/:customerId/adjust',
  async (c) => {
    const body = await parseJsonBody(
      c.req.raw,
      communityPointAdminAdjustmentSchema,
    );
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const result = await new CommunityPointAdminAdjustmentService(db).adjust(
        c.req.param('customerId'),
        body,
        auditContext(c),
      );
      c.set('auditAlreadyRecorded', true);
      return ok(c, {
        transaction: serializeTransaction(result.transaction),
        account: serializeAccount(result.account),
        changed: result.changed,
      });
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);

platformCommunityPointAdjustmentRoutes.post(
  '/:customerId/suspend',
  async (c) => {
    const body = await parseJsonBody(
      c.req.raw,
      communityPointPlatformStateChangeSchema,
    );
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const result = await new CommunityPlatformStateService(db).suspend(
        c.req.param('customerId'),
        body,
        auditContext(c),
      );
      c.set('auditAlreadyRecorded', true);
      return ok(c, {
        membership: serializeMembership(result.membership),
        account: serializeAccount(result.account),
        changed: result.changed,
      });
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);

platformCommunityPointAdjustmentRoutes.post(
  '/:customerId/restore',
  async (c) => {
    const body = await parseJsonBody(
      c.req.raw,
      communityPointPlatformStateChangeSchema,
    );
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const result = await new CommunityPlatformStateService(db).restore(
        c.req.param('customerId'),
        body,
        auditContext(c),
      );
      c.set('auditAlreadyRecorded', true);
      return ok(c, {
        membership: serializeMembership(result.membership),
        account: serializeAccount(result.account),
        changed: result.changed,
      });
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);

platformCommunityPointAdjustmentRoutes.post(
  '/transactions/:transactionId/reverse',
  async (c) => {
    const body = await parseJsonBody(
      c.req.raw,
      communityPointAdminReversalSchema,
    );
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const result =
        await new CommunityPointAdminAdjustmentService(db).reverseAdjustment(
          c.req.param('transactionId'),
          body,
          auditContext(c),
        );
      c.set('auditAlreadyRecorded', true);
      return ok(c, {
        transaction: serializeTransaction(result.transaction),
        account: serializeAccount(result.account),
        changed: result.changed,
      });
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);
