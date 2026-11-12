import { and, eq, gt, isNotNull, isNull, lt, ne, or, desc } from 'drizzle-orm';
import {
  customerRefreshTokens,
  customerSessions,
  customers,
  type CustomerSessionAuthMethod,
  type CustomerSessionRevokedReason,
} from '../db/schema';
import { BaseRepository } from './base.repository';

export type CustomerSession = typeof customerSessions.$inferSelect;

export type CustomerSessionWithCustomer = {
  session: CustomerSession;
  customer: { id: string; status: string; isDeleted: boolean };
};

export type NewCustomerSessionInput = {
  customerId: string;
  authMethod: CustomerSessionAuthMethod;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
  now: Date;
  stepUpVerifiedAt?: Date | null;
  deviceLabel?: string | null;
  sourceHint?: string | null;
};

/**
 * CUSTOMER-AUTH-01B section 5.2. Every method that acts on one session takes
 * the `customerId` as well and filters on both, so a session id from a request
 * can never touch another customer's session (invariant I11). Liveness is
 * decided from timestamps by customer-auth/session-policy.ts; this class only
 * stores and reads. Not wired to any route yet (01D-2).
 */
export class CustomerSessionRepository extends BaseRepository {
  async create(input: NewCustomerSessionInput): Promise<CustomerSession> {
    const [row] = await this.db
      .insert(customerSessions)
      .values({
        customerId: input.customerId,
        authMethod: input.authMethod,
        createdAt: input.now,
        lastUsedAt: input.now,
        absoluteExpiresAt: input.absoluteExpiresAt,
        idleExpiresAt: input.idleExpiresAt,
        stepUpVerifiedAt: input.stepUpVerifiedAt ?? null,
        deviceLabel: input.deviceLabel ?? null,
        sourceHint: input.sourceHint ?? null,
      })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findById(sessionId: string): Promise<CustomerSession | undefined> {
    return this.db.query.customerSessions.findFirst({ where: eq(customerSessions.id, sessionId) });
  }

  /**
   * The per-request read: the session AND the customer's status in ONE query,
   * so authenticating a request does not add a second round trip (01B section
   * 10). `customerId` is taken from the verified token, never the request.
   */
  async findWithCustomer(
    sessionId: string,
    customerId: string,
  ): Promise<CustomerSessionWithCustomer | undefined> {
    const rows = await this.db
      .select({
        session: customerSessions,
        customer: { id: customers.id, status: customers.status, isDeleted: customers.isDeleted },
      })
      .from(customerSessions)
      .innerJoin(customers, eq(customers.id, customerSessions.customerId))
      .where(and(eq(customerSessions.id, sessionId), eq(customerSessions.customerId, customerId)))
      .limit(1);
    return rows[0];
  }

  /** Live sessions for the device list, newest activity first. */
  async listLiveForCustomer(customerId: string, now: Date): Promise<CustomerSession[]> {
    return this.db
      .select()
      .from(customerSessions)
      .where(
        and(
          eq(customerSessions.customerId, customerId),
          isNull(customerSessions.revokedAt),
          gt(customerSessions.absoluteExpiresAt, now),
          gt(customerSessions.idleExpiresAt, now),
        ),
      )
      .orderBy(desc(customerSessions.lastUsedAt));
  }

  /** Moves the idle window forward. Does nothing on a revoked session. Returns whether a row changed. */
  async touch(input: {
    sessionId: string;
    customerId: string;
    now: Date;
    idleExpiresAt: Date;
  }): Promise<boolean> {
    const rows = await this.db
      .update(customerSessions)
      .set({ lastUsedAt: input.now, idleExpiresAt: input.idleExpiresAt })
      .where(
        and(
          eq(customerSessions.id, input.sessionId),
          eq(customerSessions.customerId, input.customerId),
          isNull(customerSessions.revokedAt),
        ),
      )
      .returning({ id: customerSessions.id });
    return rows.length > 0;
  }

  /** Records a fresh re-verification inside a live session. */
  async recordStepUp(input: {
    sessionId: string;
    customerId: string;
    now: Date;
  }): Promise<boolean> {
    const rows = await this.db
      .update(customerSessions)
      .set({ stepUpVerifiedAt: input.now })
      .where(
        and(
          eq(customerSessions.id, input.sessionId),
          eq(customerSessions.customerId, input.customerId),
          isNull(customerSessions.revokedAt),
        ),
      )
      .returning({ id: customerSessions.id });
    return rows.length > 0;
  }

  /**
   * Revokes one session and every refresh token in its chain, atomically.
   * Final: `revoked_at` is only ever set from NULL (invariant I5), so a second
   * call changes nothing and returns false.
   */
  async revoke(input: {
    sessionId: string;
    customerId: string;
    reason: CustomerSessionRevokedReason;
    now: Date;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(customerSessions)
        .set({ revokedAt: input.now, revokedReason: input.reason })
        .where(
          and(
            eq(customerSessions.id, input.sessionId),
            eq(customerSessions.customerId, input.customerId),
            isNull(customerSessions.revokedAt),
          ),
        )
        .returning({ id: customerSessions.id });
      if (rows.length === 0) return false;
      await tx
        .update(customerRefreshTokens)
        .set({ revokedAt: input.now })
        .where(
          and(
            eq(customerRefreshTokens.sessionId, input.sessionId),
            isNull(customerRefreshTokens.revokedAt),
          ),
        );
      return true;
    });
  }

  /**
   * Revokes every live session of a customer, optionally keeping one (the
   * device that just changed the password). One transaction, so a password
   * change and the revocation of every other session cannot be separated
   * (01B invariant I6). Returns the number of sessions revoked.
   */
  async revokeAllForCustomer(input: {
    customerId: string;
    reason: CustomerSessionRevokedReason;
    now: Date;
    exceptSessionId?: string;
  }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(customerSessions)
        .set({ revokedAt: input.now, revokedReason: input.reason })
        .where(
          and(
            eq(customerSessions.customerId, input.customerId),
            isNull(customerSessions.revokedAt),
            input.exceptSessionId ? ne(customerSessions.id, input.exceptSessionId) : undefined,
          ),
        )
        .returning({ id: customerSessions.id });
      for (const { id } of rows) {
        await tx
          .update(customerRefreshTokens)
          .set({ revokedAt: input.now })
          .where(
            and(eq(customerRefreshTokens.sessionId, id), isNull(customerRefreshTokens.revokedAt)),
          );
      }
      return rows.length;
    });
  }

  /**
   * Removes sessions that ended before `cutoff` (expired absolutely, or
   * revoked), cascading their refresh tokens. A purge only reclaims space:
   * correctness never depends on it having run (01B section 7).
   */
  async deleteEndedBefore(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(customerSessions)
      .where(
        or(
          lt(customerSessions.absoluteExpiresAt, cutoff),
          and(isNotNull(customerSessions.revokedAt), lt(customerSessions.revokedAt, cutoff)),
        ),
      )
      .returning({ id: customerSessions.id });
    return rows.length;
  }
}
