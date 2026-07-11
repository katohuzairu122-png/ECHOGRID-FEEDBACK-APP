import { Hono } from 'hono';
import {
  updateNotificationPreferencesSchema,
  updateBusinessNotificationSettingsSchema,
  STAFF_NOTIFICATION_EVENT_TYPES,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { resolveTenantContext, type TenantVariables } from '../middleware/tenant-context';
import { requirePermission } from '../middleware/require-permission';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { NotificationService } from './notification.service';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & TenantVariables & AuditVariables;
};

/**
 * Staff-facing notification surface (Notifications Block 4). Every route
 * needs tenant context, same shape as feedbackRoutes/loyaltyRoutes. Two
 * distinct trust levels live in this one file, on purpose -- both are
 * "notifications," but they're genuinely different capabilities:
 *
 * - /preferences: SELF-service, no permission required beyond being an
 *   active member (resolveTenantContext already enforces that). Any staff
 *   member can control their own notifications, same reasoning as a
 *   customer managing their own loyalty account needing no special grant.
 * - /settings, and the send log below: business-WIDE configuration and
 *   visibility, gated by notifications:view/:manage (Owner/Admin/Manager
 *   only) -- these affect every recipient at the business and have real
 *   cost implications (the SMS cap), not just the caller's own experience.
 */
export const notificationsRoutes = new Hono<Env>();

notificationsRoutes.use('*', authenticate, resolveTenantContext);

notificationsRoutes.get('/preferences', async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const service = new NotificationService(repos, c.env.JOBS);
    const preferences = await service.listMaterializedPreferences(
      c.get('businessId'),
      { userId: c.get('userId') },
      STAFF_NOTIFICATION_EVENT_TYPES,
    );
    return ok(c, preferences);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

notificationsRoutes.patch('/preferences', async (c) => {
  const body = await parseJsonBody(c.req.raw, updateNotificationPreferencesSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const businessId = c.get('businessId');
    const recipient = { userId: c.get('userId') };

    for (const pref of body.preferences) {
      await repos.notificationPreferences.setPreference(
        businessId,
        recipient,
        pref.eventType,
        pref.channel,
        pref.enabled,
      );
    }

    const service = new NotificationService(repos, c.env.JOBS);
    const preferences = await service.listMaterializedPreferences(
      businessId,
      recipient,
      STAFF_NOTIFICATION_EVENT_TYPES,
    );
    return ok(c, preferences);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

notificationsRoutes.get('/settings', requirePermission('notifications:view'), async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const settings = await createRepositories(db).businessNotificationSettings.getOrCreateDefaults(
      c.get('businessId'),
    );
    return ok(c, settings);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

notificationsRoutes.patch('/settings', requirePermission('notifications:manage'), async (c) => {
  const body = await parseJsonBody(c.req.raw, updateBusinessNotificationSettingsSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const settings = await createRepositories(db).businessNotificationSettings.update(
      c.get('businessId'),
      body,
      c.get('userId'),
    );
    c.set('auditMetadata', {
      action: 'notifications.settings_updated',
      entityType: 'business_notification_settings',
      entityId: settings.id,
    });
    return ok(c, settings);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/** Send log -- what has actually gone out, for support/debugging. Requires
 * notifications:view since entries can include a recipient's email/phone
 * (recipientAddress), not just aggregate counts. */
notificationsRoutes.get('/', requirePermission('notifications:view'), async (c) => {
  const url = new URL(c.req.url);
  const limit = Number(url.searchParams.get('limit')) || undefined;
  const offset = Number(url.searchParams.get('offset')) || undefined;
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const items = await createRepositories(db).notifications.listForBusiness(c.get('businessId'), {
      limit,
      offset,
    });
    return ok(c, items);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
