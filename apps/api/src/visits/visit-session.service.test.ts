import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VisitSessionService } from './visit-session.service';
import type { VisitSession, NewVisitSession } from '../repositories/visit-session.repository';

/**
 * Faithfully reproduces recordUse's real conditional UPDATE (status='active'
 * AND isDeleted=false AND expiresAt>now() AND (maxUses IS NULL OR
 * useCount<maxUses)) in plain JS -- unlike qr-code.service.test.ts's fake
 * (which only mirrors simple single-table filters), this one stands in for
 * genuinely nontrivial SQL. What it CANNOT prove: that the real Postgres
 * UPDATE is atomic under real concurrency. Two calls against this fake still
 * execute strictly sequentially in one Node process -- nothing here yields
 * mid-check the way two genuinely concurrent Postgres connections would.
 * These tests confirm the WHERE clause's boolean logic is correct (which
 * combinations of state produce a use vs. reject it); true race-safety under
 * concurrent load is a Postgres-level guarantee this suite does not exercise
 * and is not claimed to -- there is no integration test covering that
 * property for this table yet, unlike qr_codes' own uniqueness guarantee.
 */
function createFakeVisitSessionRepo() {
  const sessions = new Map<string, VisitSession>();

  return {
    sessions,
    async findActiveByCode(branchId: string, code: string): Promise<VisitSession | undefined> {
      return [...sessions.values()].find(
        (s) => s.branchId === branchId && s.code === code && s.status === 'active' && !s.isDeleted,
      );
    },
    async create(input: NewVisitSession): Promise<VisitSession> {
      const session: VisitSession = {
        id: crypto.randomUUID(),
        businessId: input.businessId,
        branchId: input.branchId,
        code: input.code,
        status: input.status ?? 'active',
        expiresAt: input.expiresAt,
        maxUses: input.maxUses ?? null,
        useCount: input.useCount ?? 0,
        createdAt: new Date(),
        createdBy: input.createdBy ?? null,
        updatedAt: new Date(),
        updatedBy: input.updatedBy ?? null,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
      };
      sessions.set(session.id, session);
      return session;
    },
    async recordUse(id: string): Promise<VisitSession | undefined> {
      const session = sessions.get(id);
      if (!session) return undefined;
      const qualifies =
        session.status === 'active' &&
        !session.isDeleted &&
        session.expiresAt.getTime() > Date.now() &&
        (session.maxUses === null || session.useCount < session.maxUses);
      if (!qualifies) return undefined;
      session.useCount += 1;
      session.updatedAt = new Date();
      return session;
    },
    async revoke(id: string, businessId: string, revokedBy: string): Promise<void> {
      const session = sessions.get(id);
      if (session && session.businessId === businessId) {
        session.status = 'revoked';
        session.updatedBy = revokedBy;
        session.updatedAt = new Date();
      }
    },
  };
}

const BUSINESS_A = 'business-a';
const BRANCH_A = 'branch-a';
const ACTOR = 'actor-user-id';

describe('VisitSessionService', () => {
  let repos: { visitSessions: ReturnType<typeof createFakeVisitSessionRepo> };
  let service: VisitSessionService;

  beforeEach(() => {
    repos = { visitSessions: createFakeVisitSessionRepo() };
    service = new VisitSessionService(repos as unknown as ConstructorParameters<typeof VisitSessionService>[0]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('issue', () => {
    it('creates an active session with the given business/branch and a 6-character code from the expected alphabet', async () => {
      const session = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 3600 });
      expect(session.businessId).toBe(BUSINESS_A);
      expect(session.branchId).toBe(BRANCH_A);
      expect(session.status).toBe('active');
      expect(session.useCount).toBe(0);
      expect(session.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    });

    it('defaults maxUses to null (a table session, unlimited within expiresAt) when omitted', async () => {
      const session = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 3600 });
      expect(session.maxUses).toBeNull();
    });

    it('sets expiresAt exactly ttlSeconds from now', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const session = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 900 });
      expect(session.expiresAt.getTime()).toBe(now + 900_000);
    });
  });

  describe('verify -- table session (maxUses null)', () => {
    it('verifies successfully and can be reused across multiple visits within the window', async () => {
      const issued = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 3600 });

      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toMatchObject({ verified: true });

      const second = await service.verify(BUSINESS_A, BRANCH_A, issued.code);
      expect(second).toMatchObject({ verified: true });
      expect(second.metadata).toMatchObject({ useCount: 2 });
    });
  });

  describe('verify -- one-time/N-time visit token (maxUses set)', () => {
    it('verifies successfully once for a maxUses=1 token, then rejects the second attempt', async () => {
      const issued = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 3600, maxUses: 1 });

      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toMatchObject({ verified: true });
      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toEqual({
        verified: false,
        reasonCode: 'invalid_or_expired',
      });
    });

    it('allows exactly N successful verifications for a maxUses=N token, then rejects the N+1th', async () => {
      const issued = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 3600, maxUses: 2 });

      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toMatchObject({ verified: true });
      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toMatchObject({ verified: true });
      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toEqual({
        verified: false,
        reasonCode: 'invalid_or_expired',
      });
    });
  });

  describe('verify -- rejection cases, all sharing the identical reason code', () => {
    it('rejects an unknown code', async () => {
      await expect(service.verify(BUSINESS_A, BRANCH_A, 'BADCOD')).resolves.toEqual({
        verified: false,
        reasonCode: 'invalid_or_expired',
      });
    });

    it('rejects a code presented at the wrong branch', async () => {
      const issued = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 3600 });
      await expect(service.verify(BUSINESS_A, 'some-other-branch', issued.code)).resolves.toEqual({
        verified: false,
        reasonCode: 'invalid_or_expired',
      });
    });

    it('rejects a code checked against the wrong business WITHOUT consuming a use -- the wrong-business attempt does not burn the one use of a maxUses=1 token', async () => {
      const issued = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 3600, maxUses: 1 });

      await expect(service.verify('some-other-business', BRANCH_A, issued.code)).resolves.toEqual({
        verified: false,
        reasonCode: 'invalid_or_expired',
      });
      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toMatchObject({ verified: true });
    });

    it('rejects an expired session even with uses still remaining', async () => {
      vi.useFakeTimers();
      const issued = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 60 });

      vi.setSystemTime(Date.now() + 61_000);
      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toEqual({
        verified: false,
        reasonCode: 'invalid_or_expired',
      });
    });

    it('rejects a revoked session even before it would otherwise expire or exhaust', async () => {
      const issued = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 3600 });
      await service.revoke(issued.id, BUSINESS_A, ACTOR);

      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toEqual({
        verified: false,
        reasonCode: 'invalid_or_expired',
      });
    });
  });

  describe('revoke', () => {
    it('is a no-op across tenant boundaries -- revoking with the wrong businessId leaves the session usable', async () => {
      const issued = await service.issue(BUSINESS_A, BRANCH_A, ACTOR, { ttlSeconds: 3600 });
      await service.revoke(issued.id, 'some-other-business', ACTOR);

      await expect(service.verify(BUSINESS_A, BRANCH_A, issued.code)).resolves.toMatchObject({ verified: true });
    });
  });
});
