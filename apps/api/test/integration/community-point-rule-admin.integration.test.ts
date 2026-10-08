import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CommunityPointRuleAdminService } from '../../src/community/community-point-rule-admin.service';

describe.skipIf(!process.env.DATABASE_URL)(
  'Split 05 Community Point rule administration (integration)',
  () => {
    let client: Client;
    let db: ReturnType<typeof buildDb>;
    let actorUserId: string;
    let campaignId: string;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      db = buildDb(client);

      const actor = await createRepositories(db).users.create({
        email: `community-rule-admin-${crypto.randomUUID()}@example.test`,
        passwordHash: 'not-used-in-integration',
        fullName: 'Community Rule Admin',
        status: 'active',
        emailVerifiedAt: new Date(),
        platformRole: 'admin',
      });
      actorUserId = actor.id;

      const business = await createRepositories(db).businesses.create({
        name: 'Community Rule Admin Business',
        slug: `community-rule-admin-${crypto.randomUUID()}`,
      });
      const survey = await createRepositories(db).surveys.createSurvey({
        ownerType: 'business',
        businessId: business.id,
        name: 'Community Rule Admin Survey',
        status: 'published',
      });
      const { version } = await createRepositories(db).surveys.createVersionWithQuestions(
        {
          surveyId: survey.id,
          version: 1,
          status: 'published',
          title: 'Community Rule Admin Survey v1',
          publishedAt: new Date(),
        },
        [],
      );
      const campaign = await createRepositories(db).surveys.createCampaign({
        surveyId: survey.id,
        surveyVersionId: version.id,
        businessId: business.id,
        name: 'Community Rule Admin Campaign',
        status: 'active',
        audienceClass: 'general_authenticated_participant',
        repeatPolicy: 'once_per_campaign',
      });
      campaignId = campaign.id;
    });

    afterAll(async () => {
      await client.end();
    });

    const audit = () => ({
      actorUserId,
      ipAddress: '203.0.113.10',
      userAgent: 'split-05-integration',
    });

    it('allocates versions, enforces one active rule per scope, and audits lifecycle changes', async () => {
      const service = new CommunityPointRuleAdminService(db);

      const v1 = await service.create(
        {
          sourceType: 'survey_completion',
          resourceType: 'survey_campaign',
          resourceId: campaignId,
          points: 40,
        },
        audit(),
      );
      const v2 = await service.create(
        {
          sourceType: 'survey_completion',
          resourceType: 'survey_campaign',
          resourceId: campaignId,
          points: 60,
        },
        audit(),
      );

      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect(v1.status).toBe('draft');
      expect(v2.status).toBe('draft');

      const activatedV1 = await service.activate(v1.id, audit());
      expect(activatedV1.changed).toBe(true);
      expect(activatedV1.rule.status).toBe('active');

      await expect(service.activate(v2.id, audit())).rejects.toMatchObject({
        status: 409,
        code: 'COMMUNITY_POINT_RULE_SCOPE_ACTIVE',
      });

      const pausedV1 = await service.pause(v1.id, audit());
      expect(pausedV1.changed).toBe(true);
      expect(pausedV1.rule.status).toBe('paused');

      const activatedV2 = await service.activate(v2.id, audit());
      expect(activatedV2.changed).toBe(true);
      expect(activatedV2.rule.status).toBe('active');

      const replay = await service.activate(v2.id, audit());
      expect(replay.changed).toBe(false);
      expect(replay.rule.status).toBe('active');

      const retired = await service.retire(v2.id, audit());
      expect(retired.changed).toBe(true);
      expect(retired.rule.status).toBe('retired');
      expect(retired.rule.retiredAt).not.toBeNull();

      await expect(service.activate(v2.id, audit())).rejects.toMatchObject({
        status: 409,
        code: 'COMMUNITY_POINT_RULE_RETIRED',
      });

      const repos = createRepositories(db);
      const v1Audit = await repos.auditLog.listForEntity('community_point_rule', v1.id);
      const v2Audit = await repos.auditLog.listForEntity('community_point_rule', v2.id);

      expect(v1Audit.map((entry) => entry.action)).toEqual(
        expect.arrayContaining([
          'community_point_rule.created',
          'community_point_rule.activated',
          'community_point_rule.paused',
        ]),
      );
      expect(v2Audit.map((entry) => entry.action)).toEqual(
        expect.arrayContaining([
          'community_point_rule.created',
          'community_point_rule.activated',
          'community_point_rule.retired',
        ]),
      );

      // Failed/conflicting/no-op transitions do not manufacture semantic
      // lifecycle audit rows.
      expect(
        v2Audit.filter((entry) => entry.action === 'community_point_rule.activated'),
      ).toHaveLength(1);
    });

    it('rolls back rule creation when the required transactional audit write fails', async () => {
      const repos = createRepositories(db);
      const before = await repos.communityPointRules.findLatestVersion(
        'survey_completion',
        'survey_campaign',
        campaignId,
      );

      await expect(
        new CommunityPointRuleAdminService(db).create(
          {
            sourceType: 'survey_completion',
            resourceType: 'survey_campaign',
            resourceId: campaignId,
            points: 75,
          },
          {
            actorUserId: crypto.randomUUID(),
            ipAddress: null,
            userAgent: null,
          },
        ),
      ).rejects.toBeDefined();

      const after = await repos.communityPointRules.findLatestVersion(
        'survey_completion',
        'survey_campaign',
        campaignId,
      );

      expect(after?.id).toBe(before?.id);
      expect(after?.version).toBe(before?.version);
    });
  },
);
