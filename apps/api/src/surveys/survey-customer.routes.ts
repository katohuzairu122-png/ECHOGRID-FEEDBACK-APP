import { Hono, type Context } from 'hono';
import {
  startSurveyParticipationSchema,
  submitSurveyParticipationSchema,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { SurveyParticipationService } from './survey-participation.service';

type Env = {
  Bindings: Bindings;
  Variables: CustomerAuthVariables;
};

export const surveyCustomerRoutes = new Hono<Env>();

surveyCustomerRoutes.use('*', customerAuthenticate, rateLimit('PUBLIC_RATE_LIMITER'));

function serializeParticipation(row: {
  id: string;
  surveyId: string;
  surveyVersionId: string;
  campaignId: string;
  participantCustomerId: string;
  businessId: string | null;
  branchId: string | null;
  status: 'started' | 'submitted' | 'completed' | 'invalidated';
  source: 'direct' | 'business_qr' | 'customer_qr' | 'link' | 'staff_assisted' | 'other';
  startedAt: Date;
  submittedAt: Date | null;
  completedAt: Date | null;
  invalidatedAt: Date | null;
}) {
  return {
    id: row.id,
    surveyId: row.surveyId,
    surveyVersionId: row.surveyVersionId,
    campaignId: row.campaignId,
    participantCustomerId: row.participantCustomerId,
    businessId: row.businessId,
    branchId: row.branchId,
    status: row.status,
    source: row.source,
    startedAt: row.startedAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
  };
}

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

surveyCustomerRoutes.get('/campaigns/:campaignId', async (c) => {
  return withDb(c, async (db) => {
    const result = await new SurveyParticipationService(db).getCampaign(
      c.get('customerId'),
      c.req.param('campaignId'),
    );
    return ok(c, result);
  });
});

surveyCustomerRoutes.post('/campaigns/:campaignId/start', async (c) => {
  const body = await parseJsonBody(c.req.raw, startSurveyParticipationSchema);
  return withDb(c, async (db) => {
    const result = await new SurveyParticipationService(db).start(
      c.get('customerId'),
      c.req.param('campaignId'),
      body,
    );
    return ok(
      c,
      { participation: serializeParticipation(result.participation), inserted: result.inserted },
      result.inserted ? 201 : 200,
    );
  });
});

surveyCustomerRoutes.post('/campaigns/:campaignId/submit', async (c) => {
  const body = await parseJsonBody(c.req.raw, submitSurveyParticipationSchema);
  return withDb(c, async (db) => {
    const participation = await new SurveyParticipationService(db).submit(
      c.get('customerId'),
      c.req.param('campaignId'),
      body,
    );
    return ok(c, serializeParticipation(participation));
  });
});

surveyCustomerRoutes.get('/participations', async (c) => {
  return withDb(c, async (db) => {
    const rows = await createRepositories(db).surveyParticipations.listForCustomer(
      c.get('customerId'),
    );
    return ok(c, rows.map(serializeParticipation));
  });
});
