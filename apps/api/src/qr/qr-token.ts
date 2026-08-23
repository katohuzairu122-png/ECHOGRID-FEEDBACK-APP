import { sign, verify } from 'hono/jwt';

/**
 * Continuing Development Block 3.2 (S5.1/S5.2) -- replaces the pre-3.2
 * opaque-random `qr_codes.token` column with a signed, expiring JWT built
 * from the row's own id. Same signing primitive as auth/jwt.ts and
 * customer-auth/customer-jwt.ts (hono/jwt, HS256, Workers-native).
 *
 * Claim mapping against S5.2's list ("tenant, business, branch, campaign,
 * QR identifier, issue time, expiry time, nonce, signature version"):
 * - tenant/business -> `businessId`. This schema has no tenant concept
 *   separate from business (every existing "tenant isolation" check in
 *   this codebase scopes by businessId) -- one claim covers both.
 * - branch -> `branchId`.
 * - campaign -> `campaignId`, always `null` today. The Reward Panel
 *   (Blocks 10-14) is what adds a real campaigns table; `qr_codes` has no
 *   campaign column to reference yet. The claim exists now so wiring a
 *   real value in later is a signing-call change, not a payload-shape
 *   migration -- deliberately NOT inventing a campaigns concept ahead of
 *   that block's own design.
 * - QR identifier -> `sub` (qr_codes.id).
 * - issue/expiry time -> `iat`/`exp`.
 * - nonce -> `nonce`. NOT an anti-replay check -- the same physical QR
 *   code is legitimately scanned by many different customers repeatedly,
 *   so "seen before" can't mean "reject." Its job is uniqueness/audit
 *   only (e.g. telling apart two tokens re-signed for the same row a
 *   second apart).
 * - signature version -> `sigVer`. Recorded for audit and future use;
 *   verifyQrToken below does NOT branch on it today (see its own comment)
 *   -- a two-secret rotation window doesn't yet justify a keyed lookup.
 */
export type QrTokenPayload = {
  sub: string; // qr_codes.id
  businessId: string;
  branchId: string;
  campaignId: string | null;
  type: 'qr_feedback';
  sigVer: number;
  nonce: string;
  iat: number;
  exp: number;
};

export const QR_TOKEN_SIGNATURE_VERSION = 1;

/**
 * Deliberately long, and deliberately a judgment call, not a verified
 * requirement: QR codes are physically printed (table tents, window
 * stickers) and QrCodeService now signs a fresh token on every read
 * (dashboard open, download), so most businesses never notice this TTL --
 * but a specific PRINTED COPY that isn't refreshed for a full year will
 * stop scanning when it lapses, with no reminder mechanism yet (a natural
 * follow-up, not built this block). 365 days balances that physical
 * constraint against still giving "expiring" real fraud-control value: a
 * leaked or abandoned token doesn't stay valid forever untracked.
 */
export const QR_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function signQrToken(
  params: { qrCodeId: string; businessId: string; branchId: string; campaignId?: string | null },
  secret: string,
): Promise<string> {
  const iat = now();
  const payload: QrTokenPayload = {
    sub: params.qrCodeId,
    businessId: params.businessId,
    branchId: params.branchId,
    campaignId: params.campaignId ?? null,
    type: 'qr_feedback',
    sigVer: QR_TOKEN_SIGNATURE_VERSION,
    nonce: crypto.randomUUID(),
    iat,
    exp: iat + QR_TOKEN_TTL_SECONDS,
  };
  return sign(payload, secret, 'HS256');
}

async function verifyWithSecret(token: string, secret: string): Promise<QrTokenPayload> {
  const payload = (await verify(token, secret, 'HS256')) as QrTokenPayload;
  if (payload.type !== 'qr_feedback') throw new Error('Not a QR token');
  return payload;
}

/**
 * `previousSecret` is how QR_TOKEN_SECRET rotation (S5.2's "support
 * signing-key rotation") actually works: to rotate, set
 * QR_TOKEN_SECRET_PREVIOUS to the outgoing secret and QR_TOKEN_SECRET to a
 * new one, redeploy -- tokens already signed under the old secret keep
 * verifying (via this fallback) while everything freshly signed uses the
 * new one, then clear QR_TOKEN_SECRET_PREVIOUS once the old TTL window has
 * fully elapsed. Tries both unconditionally rather than branching on the
 * token's own `sigVer` claim -- with only ever two live secrets, a keyed
 * lookup isn't worth the complexity; a wrong-secret attempt just fails
 * HMAC verification harmlessly.
 *
 * Throws (does not distinguish expired vs. malformed vs. bad-signature) --
 * same broad-catch convention as auth.service.ts's
 * verifyRefreshTokenOrThrow. Callers decide what, if anything, to record
 * about the rejection; this function only ever proves or disproves the
 * signature and claims.
 */
export async function verifyQrToken(
  token: string,
  secret: string,
  previousSecret?: string,
): Promise<QrTokenPayload> {
  try {
    return await verifyWithSecret(token, secret);
  } catch (err) {
    if (!previousSecret) throw err;
    return verifyWithSecret(token, previousSecret);
  }
}
