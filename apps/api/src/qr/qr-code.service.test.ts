import { describe, it, expect, beforeEach } from 'vitest';
import { QrCodeService } from './qr-code.service';
import type { QrCode, NewQrCode } from '../repositories/qr-code.repository';

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
    async findActiveByToken(token: string): Promise<QrCode | undefined> {
      return [...codes.values()].find(
        (c) => c.token === token && c.status === 'active' && !c.isDeleted,
      );
    },
    async create(input: NewQrCode): Promise<QrCode> {
      const code: QrCode = {
        id: crypto.randomUUID(),
        businessId: input.businessId,
        branchId: input.branchId,
        token: input.token,
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

const BUSINESS_A = 'business-a';
const BRANCH_A = 'branch-a';
const ACTOR = 'actor-user-id';

describe('QrCodeService', () => {
  let repos: { qrCodes: ReturnType<typeof createFakeQrCodeRepo> };
  let service: QrCodeService;

  beforeEach(() => {
    repos = { qrCodes: createFakeQrCodeRepo() };
    service = new QrCodeService(repos as unknown as ConstructorParameters<typeof QrCodeService>[0]);
  });

  it('getOrCreateActiveForBranch creates a new active code when none exists', async () => {
    const code = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    expect(code.branchId).toBe(BRANCH_A);
    expect(code.status).toBe('active');
    expect(code.token).toHaveLength(20);
  });

  it('getOrCreateActiveForBranch returns the existing code on a second call, not a new one -- lazy get-or-create', async () => {
    const first = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    const second = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    expect(second.id).toBe(first.id);
    expect(second.token).toBe(first.token);
  });

  it('regenerate revokes the old code and issues a new one with a different token', async () => {
    const first = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    const second = await service.regenerate(BRANCH_A, BUSINESS_A, ACTOR);

    expect(second.id).not.toBe(first.id);
    expect(second.token).not.toBe(first.token);
    await expect(repos.qrCodes.findById(first.id, BUSINESS_A)).resolves.toMatchObject({
      status: 'revoked',
    });
  });

  it('regenerate works even when no active code exists yet -- the first-ever regenerate call', async () => {
    const code = await service.regenerate(BRANCH_A, BUSINESS_A, ACTOR);
    expect(code.status).toBe('active');
  });

  it('resolveToken returns the matching active code', async () => {
    const created = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    await expect(service.resolveToken(created.token)).resolves.toMatchObject({ id: created.id });
  });

  it('resolveToken throws 404 for an unknown token', async () => {
    await expect(service.resolveToken('does-not-exist')).rejects.toMatchObject({
      code: 'QR_CODE_NOT_FOUND',
      status: 404,
    });
  });

  it('resolveToken throws the SAME 404 for a revoked token as for an unknown one -- enumeration resistance', async () => {
    const created = await service.getOrCreateActiveForBranch(BRANCH_A, BUSINESS_A, ACTOR);
    await repos.qrCodes.revoke(created.id, BUSINESS_A, ACTOR);

    await expect(service.resolveToken(created.token)).rejects.toMatchObject({
      code: 'QR_CODE_NOT_FOUND',
    });
  });
});
