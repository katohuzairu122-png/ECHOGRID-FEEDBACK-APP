import { Hono } from 'hono';
import {
  createCommunityPointRuleSchema,
  type CommunityPointRuleDto,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import type { CommunityPointRule } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import {
  requirePlatformRole,
  type PlatformVariables,
} from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import {
  requireCommunityPlatformPermission,
} from './community-permissions';
import { CommunityPointRuleAdminService } from '../community/community-point-rule-admin.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables & AuditVariables;
};

export const platformCommunityPointRulesRoutes = new Hono<Env>();

platformCommunityPointRulesRoutes.use(
  '*',
  authenticate,
  requirePlatformRole(['support', 'billing', 'admin']),
);

function serializeRule(rule: CommunityPointRule): CommunityPointRuleDto {
  return {
    id: rule.id,
    sourceType: rule.sourceType,
    resourceType: rule.resourceType,
    resourceId: rule.resourceId,
    version: rule.version,
    status: rule.status,
    points: rule.points,
    startsAt: rule.startsAt?.toISOString() ?? null,
    endsAt: rule.endsAt?.toISOString() ?? null,
    createdAt: rule.createdAt.toISOString(),
    activatedAt: rule.activatedAt?.toISOString() ?? null,
    retiredAt: rule.retiredAt?.toISOString() ?? null,
  };
}

function auditContext(c: Parameters<typeof ok>[0]) {
  return {
    actorUserId: c.get('userId') as string,
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
}

platformCommunityPointRulesRoutes.get(
  '/',
  requireCommunityPlatformPermission('community:rules:view'),
  async (c) => {
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const rows = await new CommunityPointRuleAdminService(db).list();
      return ok(c, rows.map(serializeRule));
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);

platformCommunityPointRulesRoutes.post(
  '/',
  requireCommunityPlatformPermission('community:rules:manage'),
  async (c) => {
    const body = await parseJsonBody(c.req.raw, createCommunityPointRuleSchema);
    const { db, close } = await createDb(c.env.HYPERDRIVE);
    try {
      const rule = await new CommunityPointRuleAdminService(db).create(
        body,
        auditContext(c),
      );
      c.set('auditAlreadyRecorded', true);
      return ok(c, serializeRule(rule), 201);
    } finally {
      c.executionCtx.waitUntil(close());
    }
  },
);

for (const action of ['activate', 'pause', 'retire'] as const) {
  platformCommunityPointRulesRoutes.post(
    `/:id/${action}`,
    requireCommunityPlatformPermission('community:rules:manage'),
    async (c) => {
      const { db, close } = await createDb(c.env.HYPERDRIVE);
      try {
        const service = new CommunityPointRuleAdminService(db);
        const result =
          action === 'activate'
            ? await service.activate(c.req.param('id'), auditContext(c))
            : action === 'pause'
              ? await service.pause(c.req.param('id'), auditContext(c))
              : await service.retire(c.req.param('id'), auditContext(c));

        if (result.changed) {
          c.set('auditAlreadyRecorded', true);
        }
        return ok(c, serializeRule(result.rule));
      } finally {
        c.executionCtx.waitUntil(close());
      }
    },
  );
}
