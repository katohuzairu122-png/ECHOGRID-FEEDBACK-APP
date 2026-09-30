import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { teamInvitations } from '../db/schema';
import { BaseRepository } from './base.repository';

export type TeamInvitation = typeof teamInvitations.$inferSelect;
export type NewTeamInvitation = typeof teamInvitations.$inferInsert;

export class TeamInvitationRepository extends BaseRepository {
  async create(input: NewTeamInvitation): Promise<TeamInvitation> {
    const [row] = await this.db.insert(teamInvitations).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async listPending(businessId: string) {
    return this.db.query.teamInvitations.findMany({
      where: and(eq(teamInvitations.businessId, businessId), isNull(teamInvitations.acceptedAt), isNull(teamInvitations.cancelledAt)),
      orderBy: (i, { desc }) => [desc(i.createdAt)],
      with: { role: true, branch: true },
    });
  }

  async findPending(id: string, businessId: string) {
    return this.db.query.teamInvitations.findFirst({
      where: and(eq(teamInvitations.id, id), eq(teamInvitations.businessId, businessId), isNull(teamInvitations.acceptedAt), isNull(teamInvitations.cancelledAt)),
    });
  }

  async findUsableByHash(tokenHash: string, now: Date) {
    return this.db.query.teamInvitations.findFirst({
      where: and(eq(teamInvitations.tokenHash, tokenHash), isNull(teamInvitations.acceptedAt), isNull(teamInvitations.cancelledAt), gt(teamInvitations.expiresAt, now)),
    });
  }

  async rotate(id: string, businessId: string, tokenHash: string, expiresAt: Date) {
    const [row] = await this.db.update(teamInvitations).set({ tokenHash, expiresAt, updatedAt: new Date() })
      .where(and(eq(teamInvitations.id, id), eq(teamInvitations.businessId, businessId), isNull(teamInvitations.acceptedAt), isNull(teamInvitations.cancelledAt))).returning();
    return row;
  }

  async cancel(id: string, businessId: string): Promise<boolean> {
    const rows = await this.db.update(teamInvitations).set({ cancelledAt: new Date(), updatedAt: new Date() })
      .where(and(eq(teamInvitations.id, id), eq(teamInvitations.businessId, businessId), isNull(teamInvitations.acceptedAt), isNull(teamInvitations.cancelledAt))).returning({ id: teamInvitations.id });
    return rows.length > 0;
  }

  async accept(id: string, now: Date): Promise<boolean> {
    const rows = await this.db.update(teamInvitations).set({ acceptedAt: now, updatedAt: now })
      .where(and(eq(teamInvitations.id, id), isNull(teamInvitations.acceptedAt), isNull(teamInvitations.cancelledAt), gt(teamInvitations.expiresAt, now))).returning({ id: teamInvitations.id });
    return rows.length > 0;
  }

  async countPendingDistinctEmails(businessId: string): Promise<number> {
    const [row] = await this.db.select({ count: sql<number>`count(distinct ${teamInvitations.email})::int` }).from(teamInvitations)
      .where(and(eq(teamInvitations.businessId, businessId), isNull(teamInvitations.acceptedAt), isNull(teamInvitations.cancelledAt), gt(teamInvitations.expiresAt, new Date())));
    return row?.count ?? 0;
  }
}
