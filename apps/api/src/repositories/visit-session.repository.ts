import { eq, and, or, isNull, gt, sql } from 'drizzle-orm';
import { visitSessions } from '../db/schema';
import { BaseRepository } from './base.repository';

export type VisitSession = typeof visitSessions.$inferSelect;
export type NewVisitSession = typeof visitSessions.$inferInsert;

export class VisitSessionRepository extends BaseRepository {
  async findById(id: string, businessId: string): Promise<VisitSession | undefined> {
    return this.db.query.visitSessions.findFirst({
      where: and(
        eq(visitSessions.id, id),
        eq(visitSessions.businessId, businessId),
        eq(visitSessions.isDeleted, false),
      ),
    });
  }

  /**
   * The verification-time lookup -- scoped to branchId, matching how a code
   * is actually presented (at one specific branch's entry point), the same
   * trusted-context shape qr-code.repository.ts's findActiveById doc comment
   * describes for the QR flow. Only narrows on status='active', not on
   * expiresAt/useCount vs maxUses -- matching visit-sessions.ts's no-
   * 'expired'-status design. The caller (visit-session.service.ts's verify())
   * still has to re-check expiry/exhaustion, because recordUse below has to
   * make that same check atomically at the moment of use regardless --
   * duplicating it here would just be a second, racier copy of logic that
   * already has to be correct there.
   */
  async findActiveByCode(branchId: string, code: string): Promise<VisitSession | undefined> {
    return this.db.query.visitSessions.findFirst({
      where: and(
        eq(visitSessions.branchId, branchId),
        eq(visitSessions.code, code),
        eq(visitSessions.status, 'active'),
        eq(visitSessions.isDeleted, false),
      ),
    });
  }

  async create(input: NewVisitSession): Promise<VisitSession> {
    const [row] = await this.db.insert(visitSessions).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * The one method in this file where correctness is a SQL property, not a
   * TypeScript one. A single conditional UPDATE, not a read-then-write --
   * two concurrent verify() calls racing the same maxUses=1 one-time token
   * must not both succeed. Whichever transaction's UPDATE commits second has
   * to see the first's already-incremented use_count and fail its own WHERE
   * clause, so every condition that makes a session usable is re-checked
   * here, atomically, even though findActiveByCode already confirmed this
   * row moments earlier -- that read is stale the instant a concurrent
   * request commits its own use. isDeleted is included even though a
   * revoked session's status already blocks it, purely so this WHERE is
   * never LESS strict than findActiveByCode's own guard.
   *
   * Returns undefined (not a thrown error) when the row doesn't qualify --
   * revoked, expired, or already exhausted. The caller folds that into the
   * same generic 'invalid_or_expired' reason code a missing findActiveByCode
   * result already produces, preserving the enumeration-resistance principle
   * carried over from QR-token verification (qr-token.ts): nothing here lets
   * a caller distinguish "never existed" from "exists but is now dead" from
   * "existed but got raced by another use."
   */
  async recordUse(id: string): Promise<VisitSession | undefined> {
    const [row] = await this.db
      .update(visitSessions)
      .set({ useCount: sql`${visitSessions.useCount} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(visitSessions.id, id),
          eq(visitSessions.status, 'active'),
          eq(visitSessions.isDeleted, false),
          gt(visitSessions.expiresAt, new Date()),
          or(isNull(visitSessions.maxUses), sql`${visitSessions.useCount} < ${visitSessions.maxUses}`),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Sets status='revoked' only -- does NOT soft-delete. Same reasoning as
   * qr-code.repository.ts's own revoke(): a revoked session stays fully
   * queryable for audit/history, it just fails findActiveByCode (and
   * therefore recordUse, which also filters on status='active') from this
   * point on.
   */
  async revoke(id: string, businessId: string, revokedBy: string): Promise<void> {
    await this.db
      .update(visitSessions)
      .set({ status: 'revoked', updatedBy: revokedBy, updatedAt: new Date() })
      .where(and(eq(visitSessions.id, id), eq(visitSessions.businessId, businessId)));
  }
}
