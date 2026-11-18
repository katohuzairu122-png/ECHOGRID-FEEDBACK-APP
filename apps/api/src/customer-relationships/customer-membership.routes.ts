import { Hono, type Context } from 'hono';
import { joinCustomerMembershipSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb, type Database } from '../db/client';
import { createRepositories } from '../repositories';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimitByCustomer } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { isUuid } from '../lib/uuid';
import { QrCodeService } from '../qr/qr-code.service';
import { CustomerMembershipService } from './customer-membership.service';
import { toCustomerMembershipDto, toJoinMembershipResultDto } from './membership-dto';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

export const customerMembershipRoutes = new Hono<Env>();
customerMembershipRoutes.use('*', customerAuthenticate, rateLimitByCustomer());

async function withDb<T>(c: Context<Env>, fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    return await fn(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

const membershipNotFound = () => new AppError('Membership not found.', 404, 'CUSTOMER_MEMBERSHIP_NOT_FOUND');

/** A malformed businessId cannot name a membership, so it is a 404 rather than a database error (a 500). */
function businessIdParam(c: Context<Env>): string {
  const businessId: string | undefined = c.req.param('businessId');
  if (businessId === undefined || !isUuid(businessId)) throw membershipNotFound();
  return businessId;
}

customerMembershipRoutes.get('/', async (c) =>
  withDb(c, async (db) => {
    const rows = await createRepositories(db).customerMemberships.listForCustomer(c.get('customerId'));
    return ok(c, rows.map(toCustomerMembershipDto));
  }),
);

customerMembershipRoutes.get('/:businessId', async (c) => {
  const businessId = businessIdParam(c);
  return withDb(c, async (db) => {
    const membership = await createRepositories(db).customerMemberships.findByCustomerAndBusiness(
      c.get('customerId'),
      businessId,
    );
    if (!membership) throw membershipNotFound();
    return ok(c, toCustomerMembershipDto(membership));
  });
});

customerMembershipRoutes.post('/join', async (c) => {
  const body = await parseJsonBody(c.req.raw, joinCustomerMembershipSchema);
  return withDb(c, async (db) => {
    const repos = createRepositories(db);
    const qrCode = await new QrCodeService(repos, {
      QR_TOKEN_SECRET: c.env.QR_TOKEN_SECRET,
      QR_TOKEN_SECRET_PREVIOUS: c.env.QR_TOKEN_SECRET_PREVIOUS,
    }).resolveToken(body.qrToken);

    const result = await new CustomerMembershipService(db).join({
      customerId: c.get('customerId'),
      businessId: qrCode.businessId,
      onboardingSource: 'business_qr',
      onboardingReference: qrCode.id,
      consentVersion: body.consentVersion,
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    });

    return ok(c, toJoinMembershipResultDto(result), 201);
  });
});

// The customer ends their own membership: earning and redeeming stop, the join
// consent is withdrawn, the points balance is kept for a later re-join.
// Idempotent.
customerMembershipRoutes.post('/:businessId/leave', async (c) => {
  const businessId = businessIdParam(c);
  return withDb(c, async (db) => {
    const membership = await new CustomerMembershipService(db).leave(c.get('customerId'), businessId);
    return ok(c, toCustomerMembershipDto(membership));
  });
});
