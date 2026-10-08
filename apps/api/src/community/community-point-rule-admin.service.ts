import { sql } from 'drizzle-orm';
import type { CreateCommunityPointRuleInput } from '@echo-grid-feedback/shared-types';
import type { Database, Db } from '../db/client';
import { communityPointRules } from '../db/schema';
import {
  createRepositories,
  type CommunityPointRule,
} from '../repositories';
import { AppError } from '../lib/errors';

export interface PlatformAuditContext {
  actorUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CommunityPointRuleMutationResult {
  rule: CommunityPointRule;
  changed: boolean;
}

export class CommunityPointRuleAdminService {
  constructor(private readonly db: Database) {}

  async list(): Promise<CommunityPointRule[]> {
    return createRepositories(this.db).communityPointRules.listAll();
  }

  async create(
    input: CreateCommunityPointRuleInput,
    audit: PlatformAuditContext,
  ): Promise<CommunityPointRule> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const resourceType = input.resourceType ?? null;
      const resourceId = input.resourceId ?? null;

      await this.lockScope(tx, input.sourceType, resourceType, resourceId);

      if (resourceType === 'survey_campaign' && resourceId) {
        const campaign = await repos.surveys.findCampaignById(resourceId);
        if (!campaign) {
          throw new AppError(
            'Survey campaign not found for this Community Point rule.',
            404,
            'SURVEY_CAMPAIGN_NOT_FOUND',
          );
        }
      }

      const latest = await repos.communityPointRules.findLatestVersion(
        input.sourceType,
        resourceType,
        resourceId,
      );

      const rule = await repos.communityPointRules.create({
        sourceType: input.sourceType,
        resourceType,
        resourceId,
        version: (latest?.version ?? 0) + 1,
        status: 'draft',
        points: input.points,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        createdBy: audit.actorUserId,
      });

      await repos.auditLog.record({
        businessId: null,
        actorUserId: audit.actorUserId,
        action: 'community_point_rule.created',
        entityType: 'community_point_rule',
        entityId: rule.id,
        metadata: {
          sourceType: rule.sourceType,
          resourceType: rule.resourceType,
          resourceId: rule.resourceId,
          version: rule.version,
          points: rule.points,
          startsAt: rule.startsAt?.toISOString() ?? null,
          endsAt: rule.endsAt?.toISOString() ?? null,
        },
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent,
      });

      return rule;
    });
  }

  async activate(
    id: string,
    audit: PlatformAuditContext,
  ): Promise<CommunityPointRuleMutationResult> {
    return this.changeLifecycle(id, 'active', audit);
  }

  async pause(
    id: string,
    audit: PlatformAuditContext,
  ): Promise<CommunityPointRuleMutationResult> {
    return this.changeLifecycle(id, 'paused', audit);
  }

  async retire(
    id: string,
    audit: PlatformAuditContext,
  ): Promise<CommunityPointRuleMutationResult> {
    return this.changeLifecycle(id, 'retired', audit);
  }

  private async changeLifecycle(
    id: string,
    target: 'active' | 'paused' | 'retired',
    audit: PlatformAuditContext,
  ): Promise<CommunityPointRuleMutationResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);

      await tx.execute(
        sql`select id from ${communityPointRules}
            where ${communityPointRules.id} = ${id}
            for update`,
      );
      const rule = await repos.communityPointRules.findById(id);
      if (!rule) {
        throw new AppError(
          'Community Point rule not found.',
          404,
          'COMMUNITY_POINT_RULE_NOT_FOUND',
        );
      }

      await this.lockScope(
        tx,
        rule.sourceType,
        rule.resourceType,
        rule.resourceId,
      );

      if (rule.status === target) {
        return { rule, changed: false };
      }

      if (rule.status === 'retired') {
        throw new AppError(
          'A retired Community Point rule cannot change lifecycle state.',
          409,
          'COMMUNITY_POINT_RULE_RETIRED',
        );
      }

      if (target === 'paused' && rule.status !== 'active') {
        throw new AppError(
          'Only an active Community Point rule can be paused.',
          409,
          'COMMUNITY_POINT_RULE_TRANSITION_INVALID',
        );
      }

      if (target === 'active') {
        if (rule.status !== 'draft' && rule.status !== 'paused') {
          throw new AppError(
            'Only a draft or paused Community Point rule can be activated.',
            409,
            'COMMUNITY_POINT_RULE_TRANSITION_INVALID',
          );
        }

        const active = await repos.communityPointRules.findActiveStatusForResource(
          rule.sourceType,
          rule.resourceType,
          rule.resourceId,
        );
        if (active && active.id !== rule.id) {
          throw new AppError(
            'Another Community Point rule is already active for this scope.',
            409,
            'COMMUNITY_POINT_RULE_SCOPE_ACTIVE',
            { activeRuleId: active.id },
          );
        }
      }

      const now = new Date();
      const updated = await repos.communityPointRules.updateLifecycle(
        rule.id,
        target === 'active'
          ? {
              status: 'active',
              activatedAt: rule.activatedAt ?? now,
              retiredAt: null,
            }
          : target === 'paused'
            ? { status: 'paused' }
            : { status: 'retired', retiredAt: now },
      );

      if (!updated) {
        throw new AppError(
          'Community Point rule could not be updated.',
          409,
          'COMMUNITY_POINT_RULE_CONFLICT',
        );
      }

      await repos.auditLog.record({
        businessId: null,
        actorUserId: audit.actorUserId,
        action: `community_point_rule.${target === 'active' ? 'activated' : target}`,
        entityType: 'community_point_rule',
        entityId: updated.id,
        metadata: {
          fromStatus: rule.status,
          toStatus: updated.status,
          sourceType: updated.sourceType,
          resourceType: updated.resourceType,
          resourceId: updated.resourceId,
          version: updated.version,
        },
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent,
      });

      return { rule: updated, changed: true };
    });
  }

  private async lockScope(
    db: Db,
    sourceType: string,
    resourceType: string | null,
    resourceId: string | null,
  ): Promise<void> {
    const scopeKey = `community-point-rule:${sourceType}:${resourceType ?? 'global'}:${resourceId ?? 'global'}`;
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${scopeKey}))`);
  }
}
