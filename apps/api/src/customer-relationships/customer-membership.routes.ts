import { Hono, type Context } from 'hono';
import { sql } from 'drizzle-orm';
import { peekTokenType, verifyOwnerInvitation, OWNER_INVITATION_TYPE } from '../customer-invitations/invitation-token';
import { joinAssistedMembershipSchema, joinCustomerMembershipSchema, previewAssistedMembershipSchema } from '@echo-grid-feedback/shared-types';
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
import { verifyOnboardingInvite } from './onboarding-attribution';

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
      // The branch is the one this QR code belongs to, read from the server's own row, never from the request.
      attribution: { source: 'business_qr', branchId: qrCode.branchId, reference: qrCode.id },
      consentVersion: body.consentVersion,
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    });

    return ok(c, toJoinMembershipResultDto(result), 201);
  });
});

// CASHIER-AUTH-02D: the customer accepts a one-time invitation a cashier issued at the counter. The signed invitation, not the
// request, decides the business, branch and cashier; the join itself is the same consented, idempotent, serialised workflow.
customerMembershipRoutes.post('/join-assisted', async (c) => {
  const body = await parseJsonBody(c.req.raw, joinAssistedMembershipSchema);
  // OWNER-INVITE-01: one customer-facing acceptance contract. An owner-issued invitation is recognised by its signed type and decided
  // entirely by its server row inside the join transaction; the cashier-assisted path below is unchanged.
  if (peekTokenType(body.inviteToken) === OWNER_INVITATION_TYPE) {
    const owned = await verifyOwnerInvitation(body.inviteToken, c.env.JWT_ACCESS_SECRET);
    return withDb(c, async (db) => {
      const result = await new CustomerMembershipService(db).join({
        customerId: c.get('customerId'),
        businessId: owned.businessId,
        onboardingSource: 'remote_invitation',
        onboardingReference: owned.invitationId,
        attribution: { source: 'remote_invitation', branchId: owned.branchId, reference: owned.invitationId },
        consentVersion: body.consentVersion,
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
      });
      return ok(c, toJoinMembershipResultDto(result), 201);
    });
  }
  const invite = await verifyOnboardingInvite(body.inviteToken, c.env.JWT_ACCESS_SECRET);
  return withDb(c, async (db) => {
    const result = await new CustomerMembershipService(db).join({
      customerId: c.get('customerId'),
      businessId: invite.businessId,
      onboardingSource: 'cashier_assisted',
      onboardingReference: invite.inviteId,
      attribution: {
        source: 'cashier_assisted', branchId: invite.branchId, reference: invite.inviteId,
        cashier: { userId: invite.cashierUserId, sessionId: invite.sessionId },
      },
      consentVersion: body.consentVersion,
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    });
    return ok(c, toJoinMembershipResultDto(result), 201);
  });
});

// CASHIER-AUTH-02D: what an invitation is, shown to the customer BEFORE they consent. Read-only and customer-authenticated. It reveals the
// business and branch names (already public through the business QR) and whether the customer can still use it; never anything about the cashier.
// An invalid or expired token, or one whose business or branch is gone, is the same generic refusal as at acceptance.
customerMembershipRoutes.post('/join-assisted/preview', async (c) => {
  const body = await parseJsonBody(c.req.raw, previewAssistedMembershipSchema);
  if (peekTokenType(body.inviteToken) === OWNER_INVITATION_TYPE) {
    const owned = await verifyOwnerInvitation(body.inviteToken, c.env.JWT_ACCESS_SECRET);
    return withDb(c, async (db) => {
      const repos = createRepositories(db);
      const rows = await db.execute(sql`
        SELECT b.name AS business_name, br.name AS branch_name, ci.expires_at AS expires_at
        FROM customer_invitations ci
        JOIN businesses b ON b.id = ci.business_id AND b.status = 'active'
        JOIN branches br ON br.id = ci.branch_id AND br.business_id = ci.business_id AND br.is_deleted = false AND br.status = 'active'
        WHERE ci.id = ${owned.invitationId} AND ci.business_id = ${owned.businessId} AND ci.branch_id = ${owned.branchId}
          AND ci.revoked_at IS NULL AND ci.expires_at > now()
        LIMIT 1`);
      const row = rows.rows[0] as { business_name: string; branch_name: string; expires_at: Date | string } | undefined;
      if (!row) throw new AppError('This invitation is not valid or has expired. Ask the business for a new one.', 400, 'ONBOARDING_INVITE_INVALID');
      const membership = await repos.customerMemberships.findByCustomerAndBusiness(c.get('customerId'), owned.businessId);
      const used = membership?.status === 'active' ? false : await repos.customerOnboardingEvents.remoteInviteUsed(owned.businessId, owned.invitationId);
      return ok(c, {
        status: membership?.status === 'active' ? 'already_member' : used ? 'used' : 'ready',
        businessName: row.business_name, branchName: row.branch_name, businessId: owned.businessId, expiresAt: new Date(row.expires_at).toISOString(),
      });
    });
  }
  const invite = await verifyOnboardingInvite(body.inviteToken, c.env.JWT_ACCESS_SECRET);
  return withDb(c, async (db) => {
    const repos = createRepositories(db);
    const business = await repos.businesses.findById(invite.businessId);
    const branch = await repos.branches.findById(invite.branchId, invite.businessId);
    if (!business || business.status !== 'active' || !branch || branch.status !== 'active') {
      throw new AppError('This invitation is not valid or has expired. Ask the cashier for a new one.', 400, 'ONBOARDING_INVITE_INVALID');
    }
    const membership = await repos.customerMemberships.findByCustomerAndBusiness(c.get('customerId'), invite.businessId);
    const used = membership?.status === 'active' ? false : await repos.customerOnboardingEvents.assistedInviteUsed(invite.businessId, invite.inviteId);
    return ok(c, {
      status: membership?.status === 'active' ? 'already_member' : used ? 'used' : 'ready',
      businessName: business.name,
      branchName: branch.name,
      businessId: business.id,
      expiresAt: invite.expiresAt.toISOString(),
    });
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
