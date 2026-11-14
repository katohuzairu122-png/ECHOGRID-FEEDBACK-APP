import { Hono } from 'hono';
import {
  applyCustomerSanctionSchema,
  MAX_CUSTOMER_SUSPENSION_DAYS,
  type CustomerSanctionEntryDto,
  type PlatformCustomerDetailDto,
  type PlatformCustomerDto,
} from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories, type Customer, type CustomerSanction } from '../repositories';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import type { AuditVariables } from '../middleware/audit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { maskPhone } from '../lib/mask';
import { isCustomerLimited } from '../lib/customer-limits';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables & AuditVariables;
};

/**
 * Platform customer moderation (PLATFORM-CUSTOMERS-01, D3 amendment).
 *
 * "Present, not exposed": an admin can see that a customer exists and act on
 * them to control fraud and misuse, but a platform login never returns full
 * names, emails, full phone numbers or activity. Lookup is by customer id or a
 * full phone number the admin already has; there is no free-text browse and no
 * export. Every view and every action is written to the audit log.
 */
export const platformCustomerRoutes = new Hono<Env>();

platformCustomerRoutes.use('*', authenticate);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const STATUSES = ['active', 'limited', 'suspended', 'banned'] as const;
type CustomerStatus = (typeof STATUSES)[number];
const MAX_PAGE = 50;

function toDto(customer: Customer, businessCount: number): PlatformCustomerDto {
  const limited = customer.status === 'active' && isCustomerLimited(customer);
  return {
    id: customer.id,
    maskedPhone: maskPhone(customer.phone),
    status: limited ? 'limited' : (customer.status as CustomerStatus),
    suspendedUntil: customer.suspendedUntil ? customer.suspendedUntil.toISOString() : null,
    limitedUntil: limited && customer.limitedUntil ? customer.limitedUntil.toISOString() : null,
    businessCount,
    joinedAt: customer.createdAt.toISOString(),
  };
}

function toEntry(row: CustomerSanction): CustomerSanctionEntryDto {
  return {
    id: row.id,
    action: row.action as CustomerSanctionEntryDto['action'],
    reason: row.reason,
    suspendedUntil: row.suspendedUntil ? row.suspendedUntil.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

platformCustomerRoutes.get('/', requirePlatformRole(['support', 'admin']), async (c) => {
  const url = new URL(c.req.url);
  const search = url.searchParams.get('search')?.trim() || undefined;
  const statusParam = url.searchParams.get('status');
  if (statusParam && !STATUSES.includes(statusParam as CustomerStatus)) {
    throw new AppError(
      `Invalid status filter. Must be one of ${STATUSES.join(', ')}.`,
      400,
      'INVALID_STATUS_FILTER',
    );
  }
  let id: string | undefined;
  let phone: string | undefined;
  if (search) {
    if (UUID_RE.test(search)) id = search;
    else if (E164_RE.test(search)) phone = search;
    else {
      throw new AppError(
        'Search by customer id or a full phone number (+countrycode...).',
        400,
        'INVALID_CUSTOMER_SEARCH',
      );
    }
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 25, 1), MAX_PAGE);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const withoutBusiness = url.searchParams.get('withoutBusiness') === 'true';

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const rows = await repos.customers.listForPlatform({
      id,
      phone,
      status: (statusParam as CustomerStatus) || undefined,
      withoutBusiness,
      limit,
      offset,
    });
    // The searched value is never stored in the audit log, only its kind.
    await repos.auditLog.record({
      actorUserId: c.get('userId'),
      action: 'platform.customer_list_viewed',
      entityType: 'customer',
      metadata: {
        searchKind: id ? 'id' : phone ? 'phone' : null,
        status: statusParam ?? null,
        withoutBusiness,
        resultCount: rows.length,
      },
    });
    return ok(
      c,
      rows.map((r) => toDto(r, r.businessCount)),
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

platformCustomerRoutes.get('/:id', requirePlatformRole(['support', 'admin']), async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const customer = await repos.customers.findById(id);
    if (!customer) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
    const [businessCount, history, warningCount] = await Promise.all([
      repos.customers.countBusinesses(id),
      repos.customerSanctions.listForCustomer(id),
      repos.customerSanctions.countWarnings(id),
    ]);
    await repos.auditLog.record({
      actorUserId: c.get('userId'),
      action: 'platform.customer_viewed',
      entityType: 'customer',
      entityId: id,
      metadata: {},
    });
    const detail: PlatformCustomerDetailDto = {
      ...toDto(customer, businessCount),
      warningCount,
      history: history.map(toEntry),
    };
    return ok(c, detail);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

/**
 * Warn, suspend (timed), ban or lift. Admin only. A suspension or ban must
 * follow at least one recorded warning unless the admin sets skipWarning (for
 * severe fraud); the reason is mandatory and the choice is audited. A
 * suspended or banned customer is refused by every customer-facing check
 * (they all require status 'active'), so access to every business stops.
 */
platformCustomerRoutes.post('/:id/sanctions', requirePlatformRole(['admin']), async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
  const body = await parseJsonBody(c.req.raw, applyCustomerSanctionSchema);

  let until: Date | null = null;
  if (body.action === 'suspend' || body.action === 'limit') {
    until = new Date(body.suspendedUntil as string);
    const now = Date.now();
    if (until.getTime() <= now) {
      throw new AppError(
        'The end date must be in the future.',
        400,
        'INVALID_SUSPENSION_END',
      );
    }
    if (until.getTime() > now + MAX_CUSTOMER_SUSPENSION_DAYS * 86_400_000) {
      throw new AppError(
        `A limit or suspension can last at most ${MAX_CUSTOMER_SUSPENSION_DAYS} days. Use a ban for longer.`,
        400,
        'INVALID_SUSPENSION_END',
      );
    }
  }

  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const result = await db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const customer = await repos.customers.findById(id);
      if (!customer) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');

      if (body.action === 'lift' && customer.status === 'active' && !isCustomerLimited(customer)) {
        throw new AppError('This customer is not restricted.', 409, 'CUSTOMER_NOT_RESTRICTED');
      }
      if (
        (body.action === 'limit' || body.action === 'suspend' || body.action === 'ban') &&
        !body.skipWarning
      ) {
        if ((await repos.customerSanctions.countWarnings(id)) === 0) {
          throw new AppError(
            'Record a warning first, or set skipWarning with a reason for severe fraud.',
            409,
            'WARNING_REQUIRED',
          );
        }
      }

      let updated: Customer = customer;
      const patchFor = {
        limit: { status: 'active', suspendedUntil: null, limitedUntil: until },
        suspend: { status: 'suspended', suspendedUntil: until, limitedUntil: null },
        ban: { status: 'banned', suspendedUntil: null, limitedUntil: null },
        lift: { status: 'active', suspendedUntil: null, limitedUntil: null },
      } as const;
      if (body.action !== 'warning') {
        updated = (await repos.customers.setModeration(id, patchFor[body.action])) ?? customer;
      }

      const entry = await repos.customerSanctions.record({
        customerId: id,
        action: body.action,
        reason: body.reason,
        suspendedUntil: until,
        actorUserId: c.get('userId'),
      });
      const [businessCount, history, warningCount] = await Promise.all([
        repos.customers.countBusinesses(id),
        repos.customerSanctions.listForCustomer(id),
        repos.customerSanctions.countWarnings(id),
      ]);
      return { entry, customer: updated, businessCount, history, warningCount };
    });

    c.set('auditMetadata', {
      action: 'customer.sanction_applied_by_platform',
      entityType: 'customer',
      entityId: id,
      details: {
        action: body.action,
        reason: body.reason,
        suspendedUntil: until ? until.toISOString() : null,
        skipWarning: body.skipWarning ?? false,
        sanctionId: result.entry.id,
      },
    });

    const detail: PlatformCustomerDetailDto = {
      ...toDto(result.customer, result.businessCount),
      warningCount: result.warningCount,
      history: result.history.map(toEntry),
    };
    return ok(c, detail);
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
