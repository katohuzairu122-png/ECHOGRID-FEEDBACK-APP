import { sign, verify } from 'hono/jwt';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { OnboardingVerificationState } from '../db/schema';
import { AppError } from '../lib/errors';
import { createRepositories } from '../repositories';
import { assertCashierSessionBound } from '../cashier-sessions/session-binding';

/**
 * CASHIER-AUTH-02D: attribution of a customer's onboarding to the branch and cashier it actually happened at.
 *
 * Two facts are never taken from a client: WHICH branch and WHICH cashier. A branch comes from the QR code row (business_qr) or from
 * the cashier's own server-side session (cashier_assisted); the cashier comes only from a server-signed invitation. A cashier-assisted
 * onboarding is a two-step handshake because the customer must give their own consent: the cashier issues a short-lived one-time
 * invitation from the active session, and the customer accepts it while signed in as themselves. The cashier's authority is
 * re-checked inside the join transaction, under a shared lock on the session (the same ordering rule as a purchase, see
 * cashier-sessions/session-binding.ts), so a branch switch, sign-out, disable or revocation that happens first makes the invitation
 * unusable, and one that happens after cannot change where the onboarding was recorded.
 */
export const ONBOARDING_INVITE_TTL_SECONDS = 10 * 60;
const INVITE_TYPE = 'onboarding_invite';

export type JoinAttribution =
  | { source: 'business_qr'; branchId: string; reference: string }
  | { source: 'cashier_assisted'; branchId: string; reference: string; cashier: { userId: string; sessionId: string } };

export interface OnboardingInviteClaims {
  cashierUserId: string;
  sessionId: string;
  businessId: string;
  branchId: string;
  inviteId: string;
  expiresAt: Date;
}

export async function signOnboardingInvite(
  input: { cashierUserId: string; sessionId: string; businessId: string; branchId: string },
  secret: string,
): Promise<{ token: string; inviteId: string; expiresAt: Date }> {
  const iat = Math.floor(Date.now() / 1000);
  const inviteId = crypto.randomUUID();
  const exp = iat + ONBOARDING_INVITE_TTL_SECONDS;
  // `type` is not `access`, so this can never verify as an access token, and it is useless anywhere but the assisted-join endpoint.
  const token = await sign(
    { sub: input.cashierUserId, type: INVITE_TYPE, sid: input.sessionId, biz: input.businessId, brid: input.branchId, jti: inviteId, iat, exp },
    secret,
    'HS256',
  );
  return { token, inviteId, expiresAt: new Date(exp * 1000) };
}

const invalidInvite = () => new AppError('This invitation is not valid or has expired. Ask the cashier for a new one.', 400, 'ONBOARDING_INVITE_INVALID');

export async function verifyOnboardingInvite(token: string, secret: string): Promise<OnboardingInviteClaims> {
  let payload: Record<string, unknown>;
  try {
    payload = (await verify(token, secret, 'HS256')) as Record<string, unknown>;
  } catch {
    throw invalidInvite();
  }
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const cashierUserId = str(payload.sub), sessionId = str(payload.sid), businessId = str(payload.biz), branchId = str(payload.brid), inviteId = str(payload.jti);
  if (payload.type !== INVITE_TYPE || !cashierUserId || !sessionId || !businessId || !branchId || !inviteId || typeof payload.exp !== 'number') {
    throw invalidInvite();
  }
  return { cashierUserId, sessionId, businessId, branchId, inviteId, expiresAt: new Date(payload.exp * 1000) };
}

/**
 * The contact-verification facts true RIGHT NOW, read from the authoritative records. Enrollment never implies verification.
 * Phone: customers.phone_verified_at with a phone present. Email: the credential's verified login email.
 */
export async function readVerificationState(db: Db, customerId: string): Promise<OnboardingVerificationState> {
  const repos = createRepositories(db);
  const customer = await repos.customers.findById(customerId);
  const credential = await repos.customerCredentials.findByCustomerId(customerId);
  const phone = Boolean(customer?.phone && customer.phoneVerifiedAt);
  const email = Boolean(credential?.loginEmail && credential.loginEmailVerifiedAt);
  if (phone && email) return 'phone_and_email_verified';
  if (phone) return 'phone_verified';
  if (email) return 'email_verified';
  return 'unverified';
}

/**
 * Inside the join transaction: the invitation's cashier must STILL be allowed to serve at this business and branch. Order matters:
 * the shared session lock is taken first, so a concurrent switch/sign-out either committed before (refused here) or waits for this
 * transaction to finish. Every failure is the same generic customer-facing error: the customer learns nothing about the cashier.
 */
export async function assertInviteCashierAuthorized(tx: Db, claims: { cashierUserId: string; sessionId: string; businessId: string; branchId: string }): Promise<void> {
  const refuse = () => new AppError('This invitation is no longer valid. Ask the cashier for a new one.', 409, 'ONBOARDING_INVITE_INVALID');
  try {
    await assertCashierSessionBound(tx, { userId: claims.cashierUserId, sessionId: claims.sessionId, branchId: claims.branchId });
  } catch {
    throw refuse();
  }
  const rows = await tx.execute(sql`
    SELECT 1 AS ok
    FROM users u
    JOIN businesses b ON b.id = ${claims.businessId}
    WHERE u.id = ${claims.cashierUserId} AND u.status = 'active' AND (u.locked_until IS NULL OR u.locked_until <= now())
      AND (u.managed_business_id IS NULL OR u.managed_business_id = ${claims.businessId}) AND b.status = 'active'
      AND EXISTS (
        SELECT 1 FROM user_business_roles ubr
        JOIN role_permissions rp ON rp.role_id = ubr.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE ubr.user_id = u.id AND ubr.business_id = ${claims.businessId} AND ubr.deleted_at IS NULL
          AND (ubr.branch_id IS NULL OR ubr.branch_id = ${claims.branchId}) AND p.key = 'loyalty:serve'
      )
    LIMIT 1`);
  if (rows.rows.length === 0) throw refuse();
}
