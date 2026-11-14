import { eq, and, isNull, gt, desc } from 'drizzle-orm';
import { refreshTokens, users, branches } from '../db/schema';
import { BaseRepository } from './base.repository';

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

export class RefreshTokenRepository extends BaseRepository {
  async create(input: NewRefreshToken): Promise<RefreshToken> {
    const [row] = await this.db.insert(refreshTokens).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * SEC-CASHIER-R2 F7: atomically spends a cashier selection ticket. The ticket's jti becomes the primary key of a
   * tombstone row (client 'web' with a marker hash no token can equal, born revoked, session-less, so it is never a live session and no
   * session list or liveness check can see it; the client CHECK allows only web/cashier, so no migration is needed). The insert succeeds for exactly one caller; a replay or a concurrent twin conflicts
   * on the key and gets false. The row expires with the ticket and is swept like any expired token row.
   */
  async consumeCashierTicket(input: { jti: string; userId: string; expiresAt: Date }): Promise<boolean> {
    const rows = await this.db
      .insert(refreshTokens)
      .values({
        id: input.jti,
        userId: input.userId,
        tokenHash: 'cashier-selection-ticket',
        expiresAt: input.expiresAt,
        revokedAt: new Date(),
        client: 'web',
      })
      .onConflictDoNothing()
      .returning({ id: refreshTokens.id });
    return rows.length === 1;
  }

  async findById(id: string): Promise<RefreshToken | undefined> {
    return this.db.query.refreshTokens.findFirst({ where: eq(refreshTokens.id, id) });
  }

  /** Marks a token used-and-superseded by the token issued in its place
   * (rotation), rather than a plain revoke, so the chain stays auditable. */
  async rotate(id: string, replacedByTokenId: string): Promise<boolean> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedByTokenId })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length > 0;
  }

  /**
   * DEV-11-R1: is THIS session live for THIS user? Exactly one question, answered from persisted state: an unrevoked, unexpired row with this user id AND this session id. Another session of the
   * same user, or any session of another user, never answers it.
   */
  async isSessionLive(userId: string, sessionId: string, nowMs: number): Promise<boolean> {
    const rows = await this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date(nowMs))))
      .limit(1);
    return rows.length > 0;
  }

  /** Revokes every row of one session (logout): the session ends even if an older sibling row were somehow still unrevoked. */
  async revokeSession(userId: string, sessionId: string): Promise<number> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length;
  }

  async revoke(id: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, id));
  }

  /** Active (unrevoked) sessions for a user. Expiry is a separate check the
   * caller makes against `expiresAt` -- this stays a pure "not explicitly
   * revoked" read. */
  async listActiveForUser(userId: string): Promise<RefreshToken[]> {
    return this.db.query.refreshTokens.findMany({
      where: and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
    });
  }

  /**
   * Revokes every unrevoked session for a user in one statement. Added for
   * the password-reset/change flows: a password change must not leave an
   * attacker's existing session alive for the remainder of its 30-day
   * refresh-token lifetime, which is exactly the window `refresh()`'s
   * account-status recheck (see docs/SECURITY-REVIEW.md) was added to close
   * for deactivation.
   *
   * `replacedByTokenId` is deliberately left NULL here, unlike rotate():
   * these sessions are being killed, not superseded by a specific successor,
   * and pointing them at an unrelated token would corrupt the rotation chain
   * that revoked-token-reuse detection reads.
   *
   * Returns the number of sessions actually revoked so the caller can log or
   * surface it ("signed out of N devices") without a second query.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length;
  }

  /**
   * CASHIER-PWA-01 C6: the LIVE cashier sessions of exactly one business. A session is live while it has an unrevoked,
   * unexpired row; rotation revokes the predecessor so there is one such row per session. `issuedAt` of that row is
   * the last sign-in or refresh. Business-scoped by construction: the business id is a mandatory predicate, so there is
   * no cross-business read path.
   */
  async listLiveCashierSessionsForBusiness(
    businessId: string,
    nowMs: number,
    limit = 200,
  ): Promise<CashierSessionRow[]> {
    return this.db
      .select({
        sessionId: refreshTokens.sessionId,
        userId: refreshTokens.userId,
        userName: users.fullName,
        userEmail: users.email,
        branchId: refreshTokens.branchId,
        branchName: branches.name,
        deviceLabel: refreshTokens.deviceLabel,
        lastActiveAt: refreshTokens.issuedAt,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .innerJoin(users, eq(users.id, refreshTokens.userId))
      .leftJoin(branches, eq(branches.id, refreshTokens.branchId))
      .where(
        and(
          eq(refreshTokens.client, 'cashier'),
          eq(refreshTokens.businessId, businessId),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, new Date(nowMs)),
        ),
      )
      .orderBy(desc(refreshTokens.issuedAt))
      .limit(limit) as unknown as CashierSessionRow[];
  }

  /**
   * Revokes one cashier session of one business. The predicate pins client, business and session id, so a web
   * session, another business's cashier session, or an unknown id matches nothing (returns null). Returns the
   * revoked session's owner for the audit entry.
   */
  async revokeCashierSession(
    businessId: string,
    sessionId: string,
  ): Promise<{ userId: string; branchId: string | null } | null> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.client, 'cashier'),
          eq(refreshTokens.businessId, businessId),
          eq(refreshTokens.sessionId, sessionId),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ userId: refreshTokens.userId, branchId: refreshTokens.branchId });
    return rows[0] ?? null;
  }

  /** Revokes every live cashier session of one business (and only cashier sessions: web sessions are never touched). */
  async revokeAllCashierSessionsForBusiness(businessId: string): Promise<number> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.client, 'cashier'),
          eq(refreshTokens.businessId, businessId),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ id: refreshTokens.id });
    return rows.length;
  }
}

export interface CashierSessionRow {
  sessionId: string | null;
  userId: string;
  userName: string;
  userEmail: string;
  branchId: string | null;
  branchName: string | null;
  deviceLabel: string | null;
  lastActiveAt: Date;
  expiresAt: Date;
}
