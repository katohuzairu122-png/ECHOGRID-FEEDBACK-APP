import { Hono } from 'hono';
import { generateSummarySchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AnalyticsService } from './analytics.service';
import { enqueueSummaryGeneration } from '../sentiment/sentiment-job';
import { computePeriodRange } from '../sentiment/period';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

export const analyticsRoutes = new Hono<Env>();

analyticsRoutes.use('*', authenticate, resolveTenantContext);

/** Day-bucketed sentiment counts for the trend chart. `from`/`to` default to
 * the last 30 days; see analytics.service.ts's resolveRange for capping. */
analyticsRoutes.get('/trends', requirePermission('analytics:view'), async (c) => {
  const url = new URL(c.req.url);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new AnalyticsService(createRepositories(db));
    const points = await service.trend(c.get('businessId'), {
      branchId: url.searchParams.get('branchId') ?? c.get('branchId'),
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
    });
    return ok(c, points);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/** Searchable feedback -- sentiment/rating/keyword/date filters, paginated. */
analyticsRoutes.get('/search', requirePermission('analytics:view'), async (c) => {
  const url = new URL(c.req.url);
  const sentiment = url.searchParams.get('sentiment');
  const rating = url.searchParams.get('rating');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new AnalyticsService(createRepositories(db));
    const items = await service.search(c.get('businessId'), {
      branchId: url.searchParams.get('branchId') ?? c.get('branchId'),
      sentiment:
        sentiment === 'positive' || sentiment === 'neutral' || sentiment === 'negative'
          ? sentiment
          : undefined,
      rating: rating ? Number(rating) : undefined,
      keyword: url.searchParams.get('keyword') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      limit: Number(url.searchParams.get('limit')) || undefined,
      offset: Number(url.searchParams.get('offset')) || undefined,
    });
    return ok(c, items);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/** AI-generated period summaries, most recent first. */
analyticsRoutes.get('/summaries', requirePermission('analytics:view'), async (c) => {
  const url = new URL(c.req.url);
  const periodType = url.searchParams.get('periodType');
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new AnalyticsService(createRepositories(db));
    const items = await service.listSummaries(c.get('businessId'), {
      branchId: url.searchParams.get('branchId') ?? c.get('branchId'),
      periodType: periodType === 'weekly' || periodType === 'monthly' ? periodType : undefined,
      limit: Number(url.searchParams.get('limit')) || undefined,
      offset: Number(url.searchParams.get('offset')) || undefined,
    });
    return ok(c, items);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * On-demand summary generation -- gated by analytics:manage (not
 * analytics:view) since this incurs a real Anthropic API call on every
 * invocation, unlike every GET above. Accepts only a canned periodType
 * (weekly/monthly), not an arbitrary date range -- see shared-types'
 * generateSummarySchema for why. Returns 202: the job is enqueued, not
 * completed, by the time this responds (SummaryService runs async in the
 * queue consumer).
 */
analyticsRoutes.post('/summaries/generate', requirePermission('analytics:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, generateSummarySchema);
  const { periodStart, periodEnd } = computePeriodRange(body.periodType);

  await enqueueSummaryGeneration(c.env.JOBS, {
    businessId: c.get('businessId'),
    branchId: body.branchId,
    periodType: body.periodType,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  });

  c.set('auditMetadata', {
    action: 'analytics.summary_requested',
    entityType: 'feedback_summary',
    entityId: c.get('businessId'),
  });

  return ok(c, { status: 'queued', periodType: body.periodType }, 202);
});
