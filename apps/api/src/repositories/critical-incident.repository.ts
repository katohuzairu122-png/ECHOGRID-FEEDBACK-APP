import { eq, and, isNull, lt } from 'drizzle-orm';
import { criticalIncidents } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CriticalIncident = typeof criticalIncidents.$inferSelect;
export type NewCriticalIncident = typeof criticalIncidents.$inferInsert;

export class CriticalIncidentRepository extends BaseRepository {
  async create(input: NewCriticalIncident): Promise<CriticalIncident> {
    const [row] = await this.db.insert(criticalIncidents).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findById(id: string, businessId: string): Promise<CriticalIncident | undefined> {
    return this.db.query.criticalIncidents.findFirst({
      where: and(eq(criticalIncidents.id, id), eq(criticalIncidents.businessId, businessId)),
    });
  }

  /** feedbackId is unique (see the schema's own comment), so this is a
   * clean 1:1 lookup -- used by the critical-alert trigger, which only has
   * the feedback row in hand, not the incident's own id. */
  async findByFeedbackId(feedbackId: string, businessId: string): Promise<CriticalIncident | undefined> {
    return this.db.query.criticalIncidents.findFirst({
      where: and(eq(criticalIncidents.feedbackId, feedbackId), eq(criticalIncidents.businessId, businessId)),
    });
  }

  /** Guarded by `WHERE acknowledgedAt IS NULL`, same one-way-flip pattern as
   * loyalty_transactions' confirmRedemption -- acknowledging twice (a
   * double-click, a retried request) is a no-op, not an error. */
  async acknowledge(id: string, businessId: string, acknowledgedBy: string): Promise<CriticalIncident | undefined> {
    const [row] = await this.db
      .update(criticalIncidents)
      .set({ acknowledgedAt: new Date(), acknowledgedBy })
      .where(
        and(
          eq(criticalIncidents.id, id),
          eq(criticalIncidents.businessId, businessId),
          isNull(criticalIncidents.acknowledgedAt),
        ),
      )
      .returning();
    return row;
  }

  /** Feeds the escalation sweep (scheduled job): every incident still
   * unacknowledged and not yet escalated, older than the cutoff. */
  async findUnacknowledgedOlderThan(cutoff: Date): Promise<CriticalIncident[]> {
    return this.db.query.criticalIncidents.findMany({
      where: and(
        isNull(criticalIncidents.acknowledgedAt),
        isNull(criticalIncidents.escalatedAt),
        lt(criticalIncidents.createdAt, cutoff),
      ),
    });
  }

  async markEscalated(id: string): Promise<void> {
    await this.db
      .update(criticalIncidents)
      .set({ escalatedAt: new Date() })
      .where(and(eq(criticalIncidents.id, id), isNull(criticalIncidents.escalatedAt)));
  }
}
