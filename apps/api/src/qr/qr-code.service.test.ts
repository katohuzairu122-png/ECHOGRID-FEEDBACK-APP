import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QrCodeService } from './qr-code.service';
import { verifyQrToken } from './qr-token';
import type { QrCode, NewQrCode } from '../repositories/qr-code.repository';
import type { FraudSignal, NewFraudSignal } from '../repositories/fraud-signal.repository';

/**
 * Same fake-repo style as branch.service.test.ts -- QrCodeRepository's
 * queries are simple single-table filters, so a fake gives real confidence
 * here. The one thing it can't verify -- whether the partial unique index
 * (qr_codes_branch_type_active_key) actually exists and is enforced by
 * Postgres -- is covered separately in
 * test/integration/qr-code-active-uniqueness.integration.test.ts.
 */
function createFakeQrCodeRepo() {
  const codes = new Map<string, QrCode>();

  return {
    async findById(id: string, businessId: string): Promise<QrCode | undefined> {
      const code = codes.get(id);
      return code && code.businessId === businessId && !code.isDeleted ? code : undefined;
    },
    async findActiveForBranch(branchId: string, businessId: string): Promise<QrCode | undefined> {
      return [...codes.values()].find(
        (c) =>
          c.branchId === branchId &&
          c.businessId === businessId &&
          c.status === 'active' &&
          !c.isDeleted,
      );
    },
    async findActiveById(id: string): Promise<QrCode | undefined> {
      const code = codes.get(id);
      return code && code.status === 'active' && !code.isDeleted ? code : undefined;
    },
    async create(input: NewQrCode): Promise<QrCode> {
      const code: QrCode = {
        id: crypto.randomUUID(),
        businessId: input.businessId,
        branchId: input.branchId,
        type: input.type ?? 'feedback',
        status: input.status ?? 'active',
        createdAt: new Date(),
        createdBy: input.createdBy ?? null,
        updatedAt: new Date(),
        updatedBy: input.updatedBy ?? null,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
      };
      codes.set(code.id, code);
      return code;
    },
    async revoke(id: string, businessId: string, revokedBy: string): Promise<void> {
      const code = codes.get(id);
      if (code && code.businessId === businessId) {
        code.status = 'revoked';
        code.updatedBy = revokedBy;
        code.updatedAt = new Date();
      }
    },
  };
}

/** Only `create` is exercised by QrCodeService -- resolveToken's
 * recordRejection is the one caller. Kept as a plain array (not a Map) so
 * tests can assert both "a signal was recorded" and "none was." */
function createFakeFraudSignalRepo() {
  const created: FraudSignal[] = [];

  return {
    created,
    async create(input: NewFraudSignal): Promise<FraudSignal> {
      const signal: FraudSignal = {
        id: crypto.randomUUID(),
        businessId: input.businessId,
        branchId: input.branchId,
        feedbackId: input.feedbackId ?? null,
        signalType: input.signalType,
        reasonCode: input.reasonCode,
        severity: input.severity ?? 'low',
        status: input.status ?? 'open',
        metadata: input.metadata ?? null,
        detectedAt: new Date(),
        reviewedAt: null,
        reviewedBy: null,
      };
      created.push(signal);
      return signal;
    },
  };
}

const BUSINESS_A = 'business-a';
const BRANCH_A = 'branch-a';
const ACTOR = 'actor-user-id';
const SECRET = 'qr-token-test-secret-do-not-use-in-production';
const SECRETS = { QR_TOKEN_SECRET: SECRET, QR_TOKEN_SECRET_PREVIOUS: undefined };

describe('QrCodeService', () => {
  let repos: { qrCodes: ReturnType<typeof createFakeQrCodeRepo>; fraudSignals: ReturnType<typeof createFakeFraudSignalRepo> };
  let service: QrCodeService;

  beforeEach(() => {
    repos = { qrCodes: createFakeQrCodeRepo(), fraudSignals: createFakeFraudSignalRepo() };
    service = new QrCodeService(repos as unknown as ConstructorParameters<typeof QrCodeService>[0], SECRETS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('getOrCreateActiveForBranch creates a new active code with a validly-signed token', async () => {
    const { qrCode, token } = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    expect(qrCode.branchId).toBe(BRANCH_A);
    expect(qrCode.status).toBe('active');

    const payload = await verifyQrToken(token, SECRET);
    expect(payload.sub).toBe(qrCode.id);
    expect(payload.businessId).toBe(BUSINESS_A);
    expect(payload.branchId).toBe(BRANCH_A);
    expect(payload.campaignId).toBeNull();
  });

  it('getOrCreateActiveForBranch returns the existing ROW on a second call, not a new one -- lazy get-or-create. The token is re-signed fresh each call (different nonce/iat), which is expected, not a bug', async () => {
    const first = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    const second = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    expect(second.qrCode.id).toBe(first.qrCode.id);
    await expect(verifyQrToken(second.token, SECRET)).resolves.toMatchObject({ sub: first.qrCode.id });
  });

  it('regenerate revokes the old row and issues a new one with a different id', async () => {
    const first = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    const second = await service.regenerate(BRANCH_A, BUSINESS_A, ACTOR);

    expect(second.qrCode.id).not.toBe(first.qrCode.id);
    await expect(repos.qrCodes.findById(first.qrCode.id, BUSINESS_A)).resolves.toMatchObject({
      status: 'revoked',
    });
  });

  it('regenerate works even when no active code exists yet -- the first-ever regenerate call', async () => {
    const { qrCode } = await service.regenerate(BRANCH_A, BUSINESS_A, ACTOR);
    expect(qrCode.status).toBe('active');
  });

  it('resolveToken returns the matching active code for a valid token', async () => {
    const { qrCode, token } = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    await expect(service.resolveToken(token)).resolves.toMatchObject({ id: qrCode.id });
  });

  it('resolveToken throws 404 for a malformed token, and records no fraud signal -- there is no verified businessId/branchId to attribute one to', async () => {
    await expect(service.resolveToken('not-a-real-token')).rejects.toMatchObject({
      code: 'QR_CODE_NOT_FOUND',
      status: 404,
    });
    expect(repos.fraudSignals.created).toHaveLength(0);
  });

  it('resolveToken throws 404 for a token signed with the wrong secret -- an altered/forged token', async () => {
    const { token } = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    const otherService = new QrCodeService(repos as unknown as ConstructorParameters<typeof QrCodeService>[0], {
      QR_TOKEN_SECRET: 'a-completely-different-secret',
      QR_TOKEN_SECRET_PREVIOUS: undefined,
    });
    await expect(otherService.resolveToken(token)).rejects.toMatchObject({ code: 'QR_CODE_NOT_FOUND' });
  });

  it('resolveToken throws 404 for a token whose payload segment was tampered with', async () => {
    const { token } = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    const [header, payload, signature] = token.split('.');
    // Flip a character mid-PAYLOAD, not the token's trailing character (an
    // earlier version of this test did that and was itself the CI failure:
    // a base64url segment's FINAL character can carry unused low-order
    // "padding" bits -- for this payload's byte length, 'A' vs 'B' differ
    // only in such a bit, so a lenient decoder reconstructs the identical
    // signature bytes and verification wrongly still succeeds. The
    // signature is computed over the header+payload STRING, not a decoded
    // value, so altering ANY payload character changes the HMAC input
    // unambiguously -- no equivalent edge case here.
    const midIndex = Math.floor((payload?.length ?? 0) / 2);
    const flippedChar = payload?.[midIndex] === 'A' ? 'B' : 'A';
    const tamperedPayload = `${payload?.slice(0, midIndex)}${flippedChar}${payload?.slice(midIndex + 1)}`;
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    await expect(service.resolveToken(tampered)).rejects.toMatchObject({ code: 'QR_CODE_NOT_FOUND' });
  });

  it('resolveToken throws 404 for a genuinely expired token -- first fake-timer use in this codebase, deliberately: proving exp is actually enforced (not just present in the payload) is the one property this block cannot ship unverified', async () => {
    vi.useFakeTimers();
    const { token } = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);

    vi.setSystemTime(Date.now() + 366 * 24 * 60 * 60 * 1000); // 366 days later -- past QR_TOKEN_TTL_SECONDS
    await expect(service.resolveToken(token)).rejects.toMatchObject({ code: 'QR_CODE_NOT_FOUND' });
  });

  it('resolveToken throws the SAME 404 for a revoked token as for a malformed one -- enumeration resistance -- and DOES record a fraud signal, since the token verified cryptographically first', async () => {
    const { qrCode, token } = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    await repos.qrCodes.revoke(qrCode.id, BUSINESS_A, ACTOR);

    await expect(service.resolveToken(token)).rejects.toMatchObject({ code: 'QR_CODE_NOT_FOUND' });
    expect(repos.fraudSignals.created).toHaveLength(1);
    expect(repos.fraudSignals.created[0]).toMatchObject({
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
      signalType: 'qr_token',
      reasonCode: 'revoked_or_unknown',
    });
  });
});
