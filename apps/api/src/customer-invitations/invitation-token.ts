import { sign, verify } from 'hono/jwt';
import { AppError } from '../lib/errors';

/**
 * OWNER-INVITE-01: the signed link token of an owner-issued customer invitation. It carries ONLY ids (invitation, business, branch, issuer):
 * no customer data. It is a pointer, not the authority: the database row decides whether it is still usable (not revoked, not expired, not
 * used, business and branch active, issuer still authorised). `type` is not `access`, so it can never verify as an access token, and it is
 * useless anywhere but the customer acceptance endpoints.
 */
export const OWNER_INVITATION_TYPE = 'customer_invitation';
export const DEFAULT_INVITATION_HOURS = 24;
export const MAX_INVITATION_HOURS = 168;

export interface OwnerInvitationClaims { invitationId: string; businessId: string; branchId: string; issuerUserId: string; expiresAt: Date }

export async function signOwnerInvitation(input: OwnerInvitationClaims, secret: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign(
    { sub: input.issuerUserId, type: OWNER_INVITATION_TYPE, biz: input.businessId, brid: input.branchId, jti: input.invitationId, iat, exp: Math.floor(input.expiresAt.getTime() / 1000) },
    secret, 'HS256',
  );
}

export const invalidInvitation = () => new AppError('This invitation is not valid or has expired. Ask the business for a new one.', 400, 'ONBOARDING_INVITE_INVALID');

/** Reads the `type` claim WITHOUT trusting it, only to choose which verifier to run (each verifier then verifies the signature for real). */
export function peekTokenType(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
    return typeof payload.type === 'string' ? payload.type : null;
  } catch {
    return null;
  }
}

export async function verifyOwnerInvitation(token: string, secret: string): Promise<OwnerInvitationClaims> {
  let payload: Record<string, unknown>;
  try { payload = (await verify(token, secret, 'HS256')) as Record<string, unknown>; } catch { throw invalidInvitation(); }
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const invitationId = str(payload.jti), businessId = str(payload.biz), branchId = str(payload.brid), issuerUserId = str(payload.sub);
  if (payload.type !== OWNER_INVITATION_TYPE || !invitationId || !businessId || !branchId || !issuerUserId || typeof payload.exp !== 'number') throw invalidInvitation();
  return { invitationId, businessId, branchId, issuerUserId, expiresAt: new Date(payload.exp * 1000) };
}
