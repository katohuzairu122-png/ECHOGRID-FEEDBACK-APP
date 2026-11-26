import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { GOVERNANCE_OPERATOR_ROLES, governanceOperatorEvents, governanceOperators } from '../db/schema';
import { AppError } from '../lib/errors';

export type Actor = { actorUserId: string };
export type OperatorRole = (typeof GOVERNANCE_OPERATOR_ROLES)[number];
export type OperatorScope = 'shuffle' | 'drops' | 'both';
const conflict = (m: string, code: string) => new AppError(m, 409, code);
const dbMessage = (e: unknown): string => { const x = e as { message?: string; cause?: { message?: string } }; return `${x?.message ?? ''} ${x?.cause?.message ?? ''}`; };

/**
 * G5 operator-assignment lifecycle: assign (scope, optional expiry) -> revoke, with an append-only audit event for each. An assignment is a PRIVILEGE GRANT made by the Owner: the runtime
 * role has SELECT only on these tables and there is NO HTTP route, so this service is for Owner-side privileged tooling and tests; production stays empty until the Owner assigns real
 * operators. Nothing here grants authority to a platform admin automatically. The database (not this service) enforces who counts as effective: not revoked, inside the validity window,
 * scope covering the subject family, assigner different from the assignee.
 */
export class GovernanceOperatorService {
  constructor(private readonly db: Db) {}

  async assign(input: { userId: string; role: OperatorRole; scope?: OperatorScope; validFrom?: Date; expiresAt?: Date | null }, ctx: Actor) {
    if (input.expiresAt && !(input.expiresAt.getTime() > (input.validFrom ?? new Date()).getTime())) throw new AppError('The assignment must expire after it starts.', 422, 'ASSIGNMENT_WINDOW_INVALID');
    return this.db.transaction(async (tx) => {
      try {
        const [row] = await tx.insert(governanceOperators).values({
          userId: input.userId, role: input.role, scope: input.scope ?? 'both', ...(input.validFrom ? { validFrom: input.validFrom } : {}), expiresAt: input.expiresAt ?? null, assignedByUserId: ctx.actorUserId,
        }).returning();
        await tx.insert(governanceOperatorEvents).values({ operatorId: row!.id, eventType: 'assigned', actorUserId: ctx.actorUserId, detail: { userId: input.userId, role: input.role, scope: row!.scope, expiresAt: input.expiresAt?.toISOString() ?? null } });
        return row!;
      } catch (e) {
        const m = dbMessage(e);
        if (m.includes('governance_operators_current_uq')) throw conflict('That user already holds a current assignment for this role; revoke it first.', 'ASSIGNMENT_EXISTS');
        if (m.includes('OPERATOR_NOT_ALLOWED')) throw new AppError('Separation of duties: an assignment is made by a different person.', 403, 'SEPARATION_OF_DUTIES');
        throw e;
      }
    });
  }

  async revoke(operatorId: string, reason: string, ctx: Actor) {
    if (reason.trim().length < 10) throw new AppError('A reason of at least 10 characters is required.', 422, 'REASON_REQUIRED');
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(governanceOperators).set({ active: false, revokedAt: new Date(), revokedByUserId: ctx.actorUserId, revocationReason: reason.trim() })
        .where(and(eq(governanceOperators.id, operatorId), sql`${governanceOperators.revokedAt} IS NULL`)).returning();
      if (!row) throw conflict('The assignment does not exist or is already revoked.', 'ASSIGNMENT_NOT_CURRENT');
      await tx.insert(governanceOperatorEvents).values({ operatorId, eventType: 'revoked', actorUserId: ctx.actorUserId, detail: { reason: reason.trim() } });
      return row;
    });
  }

  /** Whether the user is an EFFECTIVE operator for a role and subject family at a moment (default now). Expiry is evaluated at the moment of use, never by a background job. */
  async isEffective(userId: string, role: OperatorRole, family: 'shuffle' | 'drops', at: Date = new Date()): Promise<boolean> {
    const r = await this.db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM governance_operators o WHERE o.user_id = ${userId} AND o.role = ${role} AND o.active AND o.revoked_at IS NULL AND o.valid_from <= ${at.toISOString()}::timestamptz
        AND (o.expires_at IS NULL OR o.expires_at > ${at.toISOString()}::timestamptz) AND o.scope IN ('both', ${family})) AS ok`);
    return r.rows[0]?.ok === true;
  }

  list() { return this.db.select().from(governanceOperators).orderBy(asc(governanceOperators.createdAt)); }
  history(operatorId: string) { return this.db.select().from(governanceOperatorEvents).where(eq(governanceOperatorEvents.operatorId, operatorId)).orderBy(asc(governanceOperatorEvents.createdAt)); }
}
