import { eq, and, isNull, lt, gte, lte } from 'drizzle-orm';
import { criticalIncidents } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CriticalIncident = typeof criticalIncidents.$inferSelect;
export type NewCriticalIncident = typeof criticalIncidents.$inferInsert;

// Mirrors FeedbackRepository's identical safety cap and rationale -- a
// defensive bound on SummaryService's period sweep (S4 roadmap Block 5
// "cross-domain aggregates"), not a product-facing limit.
const MAX_PERIOD_ROWS = 5000;

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

  /** S4 roadmap Block 5 "cross-domain aggregates" -- same shape as
   * FeedbackRepository.listForPeriod (businessId, optional branchId, an
   * inclusive [from, to] window), so SummaryService can treat both the
   * same way. No soft-delete filter: critical_incidents has no
   * softDeleteColumns (see the schema's own comment -- tenant-owned
   * operational data, not something a row is ever soft-deleted out of). */
  async listForPeriod(
    businessId: string,
    options: { branchId?: string | undefined; from: Date; to: Date },
  ): Promise<CriticalIncident[]> {
    return this.db.query.criticalIncidents.findMany({
      where: and(
        eq(criticalIncidents.businessId, businessId),
        options.branchId ? eq(criticalIncidents.branchId, options.branchId) : undefined,
        gte(criticalIncidents.createdAt, options.from),
        lte(criticalIncidents.createdAt, options.to),
      ),
      limit: MAX_PERIOD_ROWS,
      orderBy: (ci, { desc }) => [desc(ci.createdAt)],
    });
  }
}
