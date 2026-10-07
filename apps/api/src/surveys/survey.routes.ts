import { Hono, type Context } from 'hono';
import {
  createSurveyCampaignSchema,
  createSurveySchema,
  createSurveyVersionSchema,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { SurveyManagementService } from './survey-management.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

export const surveyRoutes = new Hono<Env>();

surveyRoutes.use('*', authenticate, resolveTenantContext, requireBusinessWideAccess);

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

surveyRoutes.get('/', requirePermission('survey:view'), async (c) => {
  return withDb(c, async (db) => {
    const service = new SurveyManagementService(createRepositories(db));
    return ok(c, await service.listSurveys(c.get('businessId')));
  });
});

surveyRoutes.post('/', requirePermission('survey:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, createSurveySchema);
  return withDb(c, async (db) => {
    const survey = await new SurveyManagementService(createRepositories(db)).createSurvey(
      c.get('businessId'),
      body,
      c.get('userId'),
    );
    c.set('auditMetadata', {
      action: 'survey.created',
      entityType: 'survey',
      entityId: survey.id,
    });
    return ok(c, survey, 201);
  });
});

surveyRoutes.post('/:id/versions', requirePermission('survey:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, createSurveyVersionSchema);
  return withDb(c, async (db) => {
    const result = await new SurveyManagementService(createRepositories(db)).createVersion(
      c.get('businessId'),
      c.req.param('id'),
      body,
      c.get('userId'),
    );
    c.set('auditMetadata', {
      action: 'survey.version_created',
      entityType: 'survey_version',
      entityId: result.version.id,
    });
    return ok(c, result, 201);
  });
});

surveyRoutes.post(
  '/:id/versions/:versionId/publish',
  requirePermission('survey:manage'),
  async (c) => {
    return withDb(c, async (db) => {
      const version = await new SurveyManagementService(createRepositories(db)).publishVersion(
        c.get('businessId'),
        c.req.param('id'),
        c.req.param('versionId'),
        c.get('userId'),
      );
      c.set('auditMetadata', {
        action: 'survey.version_published',
        entityType: 'survey_version',
        entityId: version.id,
      });
      return ok(c, version);
    });
  },
);

surveyRoutes.post('/:id/pause', requirePermission('survey:manage'), async (c) => {
  return withDb(c, async (db) => {
    const survey = await new SurveyManagementService(createRepositories(db)).pauseSurvey(
      c.get('businessId'),
      c.req.param('id'),
      c.get('userId'),
    );
    c.set('auditMetadata', {
      action: 'survey.paused',
      entityType: 'survey',
      entityId: survey.id,
    });
    return ok(c, survey);
  });
});

surveyRoutes.post('/:id/close', requirePermission('survey:manage'), async (c) => {
  return withDb(c, async (db) => {
    const survey = await new SurveyManagementService(createRepositories(db)).closeSurvey(
      c.get('businessId'),
      c.req.param('id'),
      c.get('userId'),
    );
    c.set('auditMetadata', {
      action: 'survey.closed',
      entityType: 'survey',
      entityId: survey.id,
    });
    return ok(c, survey);
  });
});

surveyRoutes.get('/campaigns', requirePermission('survey:view'), async (c) => {
  return withDb(c, async (db) => {
    const service = new SurveyManagementService(createRepositories(db));
    return ok(c, await service.listCampaigns(c.get('businessId')));
  });
});

surveyRoutes.post('/campaigns', requirePermission('survey:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, createSurveyCampaignSchema);
  return withDb(c, async (db) => {
    const campaign = await new SurveyManagementService(createRepositories(db)).createCampaign(
      c.get('businessId'),
      body,
      c.get('userId'),
    );
    c.set('auditMetadata', {
      action: 'survey.campaign_created',
      entityType: 'survey_campaign',
      entityId: campaign.id,
    });
    return ok(c, campaign, 201);
  });
});

surveyRoutes.post('/campaigns/:id/activate', requirePermission('survey:manage'), async (c) => {
  return withDb(c, async (db) => {
    const campaign = await new SurveyManagementService(createRepositories(db)).activateCampaign(
      c.get('businessId'),
      c.req.param('id'),
      c.get('userId'),
    );
    c.set('auditMetadata', {
      action: 'survey.campaign_activated',
      entityType: 'survey_campaign',
      entityId: campaign.id,
    });
    return ok(c, campaign);
  });
});

surveyRoutes.post('/campaigns/:id/pause', requirePermission('survey:manage'), async (c) => {
  return withDb(c, async (db) => {
    const campaign = await new SurveyManagementService(createRepositories(db)).pauseCampaign(
      c.get('businessId'),
      c.req.param('id'),
      c.get('userId'),
    );
    c.set('auditMetadata', {
      action: 'survey.campaign_paused',
      entityType: 'survey_campaign',
      entityId: campaign.id,
    });
    return ok(c, campaign);
  });
});

surveyRoutes.post('/campaigns/:id/close', requirePermission('survey:manage'), async (c) => {
  return withDb(c, async (db) => {
    const campaign = await new SurveyManagementService(createRepositories(db)).closeCampaign(
      c.get('businessId'),
      c.req.param('id'),
      c.get('userId'),
    );
    c.set('auditMetadata', {
      action: 'survey.campaign_closed',
      entityType: 'survey_campaign',
      entityId: campaign.id,
    });
    return ok(c, campaign);
  });
});
