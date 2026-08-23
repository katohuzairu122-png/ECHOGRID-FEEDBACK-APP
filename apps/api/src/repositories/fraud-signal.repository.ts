import { eq, and } from 'drizzle-orm';
import { fraudSignals } from '../db/schema';
import { BaseRepository } from './base.repository';

export type FraudSignal = typeof fraudSignals.$inferSelect;
export type NewFraudSignal = typeof fraudSignals.$inferInsert;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Write/read surface for the fraud-signal log (Continuing Development
 * Block 3.1's schema). No detector calls `create` yet -- that starts with
 * Block 3.2's signed-QR-token verification -- so this repository exists
 * ahead of its first caller on purpose, same order Block 1's feedback
 * schema/repository preceded Block 2's actual detector. Matches
 * CriticalIncidentRepository's shape closely (this table is that one's
 * closest sibling): create, findById, a feedback-scoped lookup, and a
 * guarded one-way status transition.
 */
export class FraudSignalRepository extends BaseRepository {
  async create(input: NewFraudSignal): Promise<FraudSignal> {
    const [row] = await this.db.insert(fraudSignals).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findById(id: string, businessId: string): Promise<FraudSignal | undefined> {
    return this.db.query.fraudSignals.findFirst({
      where: and(eq(fraudSignals.id, id), eq(fraudSignals.businessId, businessId)),
    });
  }

  /** Plural, unlike CriticalIncidentRepository.findByFeedbackId -- feedbackId
   * is NOT unique here (see the schema's own comment): one feedback row can
   * carry more than one independent signal. */
  async findByFeedbackId(feedbackId: string, businessId: string): Promise<FraudSignal[]> {
    return this.db.query.fraudSignals.findMany({
      where: and(eq(fraudSignals.feedbackId, feedbackId), eq(fraudSignals.businessId, businessId)),
      orderBy: (fs, { desc }) => [desc(fs.detectedAt)],
    });
  }

  /** The queue Block 5's manual-review routing (and, later, the inbox's
   * "Suspected fraud" saved view -- shared-types/feedback.ts's own comment
   * already flags that view as blocked on this exact model) reads from.
   * Backed by fraud_signals_business_open_idx. */
  async listOpenForBusiness(
    businessId: string,
    options: { branchId?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<FraudSignal[]> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return this.db.query.fraudSignals.findMany({
      where: and(
        eq(fraudSignals.businessId, businessId),
        eq(fraudSignals.status, 'open'),
        options.branchId ? eq(fraudSignals.branchId, options.branchId) : undefined,
      ),
      limit,
      offset: options.offset ?? 0,
      orderBy: (fs, { desc }) => [desc(fs.detectedAt)],
    });
  }

  /** Guarded by `WHERE status = 'open'`, same one-way-flip convention as
   * CriticalIncidentRepository.acknowledge -- reviewing (or dismissing)
   * twice, e.g. a double-click or a retried request, is a no-op rather than
   * an error or a lost second reviewer's identity overwriting the first. */
  async markReviewed(id: string, businessId: string, reviewedBy: string): Promise<FraudSignal | undefined> {
    const [row] = await this.db
      .update(fraudSignals)
      .set({ status: 'reviewed', reviewedAt: new Date(), reviewedBy })
      .where(and(eq(fraudSignals.id, id), eq(fraudSignals.businessId, businessId), eq(fraudSignals.status, 'open')))
      .returning();
    return row;
  }

  async markDismissed(id: string, businessId: string, reviewedBy: string): Promise<FraudSignal | undefined> {
    const [row] = await this.db
      .update(fraudSignals)
      .set({ status: 'dismissed', reviewedAt: new Date(), reviewedBy })
      .where(and(eq(fraudSignals.id, id), eq(fraudSignals.businessId, businessId), eq(fraudSignals.status, 'open')))
      .returning();
    return row;
  }
}
