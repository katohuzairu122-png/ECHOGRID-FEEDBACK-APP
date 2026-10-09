import { Hono, type Context } from 'hono';
import { orphanSettlementReversalSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import {
  requirePlatformRole,
  type PlatformVariables,
} from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { OrphanSettlementReversalService } from '../orphan-settlement/orphan-settlement-reversal.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables & AuditVariables;
};

export const platformOrphanSettlementRoutes = new Hono<Env>();

platformOrphanSettlementRoutes.use(
  '*',
  authenticate,
  requirePlatformRole(['admin']),
);

async function withDb<T>(
  c: Context<Env>,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

function auditContext(c: Context<Env>) {
  return {
    actorUserId: c.get('userId'),
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
}

platformOrphanSettlementRoutes.post(
  '/:settlementId/reverse',
  async (c) => {
    const body = await parseJsonBody(
      c.req.raw,
      orphanSettlementReversalSchema,
    );

    return withDb(c, async (db) => {
      const result = await new OrphanSettlementReversalService(db).reverse(
        c.req.param('settlementId'),
        body,
        auditContext(c),
      );
      c.set('auditAlreadyRecorded', true);

      return ok(c, {
        settlement: {
          id: result.settlement.id,
          claimId: result.settlement.claimId,
          receivingBusinessId: result.settlement.receivingBusinessId,
          receivingBranchId: result.settlement.receivingBranchId,
          status: result.settlement.status,
          fulfilledAt: result.settlement.fulfilledAt?.toISOString() ?? null,
        },
        claim: {
          id: result.claim.id,
          status: result.claim.status,
          settledAt: result.claim.settledAt?.toISOString() ?? null,
          reversedAt: result.claim.reversedAt?.toISOString() ?? null,
        },
        reversalEvidence: {
          evidenceVersion: result.evidence.evidenceVersion,
          settlementRef: result.evidence.settlementRef,
          reversalRef: result.evidence.reversalRef,
          reversedAt: result.evidence.reversedAt,
        },
        changed: result.changed,
      });
    });
  },
);
