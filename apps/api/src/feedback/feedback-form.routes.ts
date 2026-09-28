import { Hono } from 'hono';
import { assignFeedbackFormSchema, createFeedbackFormSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import type { AuditVariables } from '../middleware/audit';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessWideAccess } from '../middleware/require-business-wide-access';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';

type Env = { Bindings: Bindings; Variables: AuthVariables & TenantVariables & AuditVariables };
export const feedbackFormRoutes = new Hono<Env>();
feedbackFormRoutes.use('*', authenticate, resolveTenantContext, requireBusinessWideAccess, requirePermission('feedback:manage'));

feedbackFormRoutes.get('/', async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return ok(c, await createRepositories(db).feedbackForms.list(c.get('businessId'))); }
  finally { c.executionCtx.waitUntil(close()); }
});

feedbackFormRoutes.post('/', async (c) => {
  const body = await parseJsonBody(c.req.raw, createFeedbackFormSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const form = await createRepositories(db).feedbackForms.createPublished(c.get('businessId'), c.get('userId'), body);
    c.set('auditMetadata', { action: 'feedback_form.created', entityType: 'feedback_form', entityId: form.formId });
    return ok(c, form, 201);
  } finally { c.executionCtx.waitUntil(close()); }
});

feedbackFormRoutes.post('/:id/versions', async (c) => {
  const body = await parseJsonBody(c.req.raw, createFeedbackFormSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try { return ok(c, await createRepositories(db).feedbackForms.createVersion(c.get('businessId'), c.req.param('id'), body), 201); }
  finally { c.executionCtx.waitUntil(close()); }
});

feedbackFormRoutes.post('/assign', async (c) => {
  const body = await parseJsonBody(c.req.raw, assignFeedbackFormSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    await createRepositories(db).feedbackForms.assign(body.qrCodeId, c.get('businessId'), body.versionId);
    return ok(c, { assigned: true });
  } finally { c.executionCtx.waitUntil(close()); }
});

