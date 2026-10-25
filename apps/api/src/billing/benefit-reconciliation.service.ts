import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { benefitApplicationIntents, benefitReconciliationAttempts } from '../db/schema';
import type { BenefitApplicationSagaService, SagaResult } from './benefit-application.saga.service';
import {
  nextRetryDelayMs, retrieveProviderEffect, toSagaObservation,
  type EffectExtractor, type ExpectedProviderScope, type ProviderEffectRetrieval, type ProviderInvoiceReader,
} from './provider-effect.adapter';

/**
 * Split 08 provider reconciliation (migration 0049, INERT). Drives ONE read-only provider re-query for an attempted benefit application, records the
 * attempt durably, and feeds the saga only what the evidence supports:
 *  - a present effect, an unreachable/incomplete/mismatching answer, or an error are forwarded (the saga consumes only on an exact, attributed match,
 *    and holds everything else);
 *  - ABSENCE is never inferred from a single query: it is forwarded as `effect_absent` only after `requiredAbsences` consecutive COMPLETE absent
 *    queries, each at least `minAbsenceGapMs` apart and all after the provider attempt began. Anything else in between (error, incomplete, a present
 *    effect, a crashed unfinished attempt) breaks the streak;
 *  - a reconciler that crashes between starting and finishing an attempt leaves a visible unfinished row that still counts as an attempt.
 * It performs no provider write, no route/queue/cron wiring, and moves no credit.
 */
export interface ReconcileContext {
  reader: ProviderInvoiceReader;
  scope: Pick<ExpectedProviderScope, 'accountId' | 'livemode' | 'customerId' | 'subscriptionId'>;
  clock?: () => Date;
  extractor?: EffectExtractor;
  requiredAbsences?: number;
  minAbsenceGapMs?: number;
  /** An unfinished attempt younger than this is considered in flight in another process. */
  inFlightWindowMs?: number;
  rand?: () => number;
}

export type ReconcileResult =
  | { status: 'skipped'; reason: 'NOT_FOUND' | 'NOT_ATTEMPTED' | 'TERMINAL' | 'IN_FLIGHT' }
  | { status: 'reconciled'; attemptNo: number; outcome: NonNullable<typeof benefitReconciliationAttempts.$inferSelect['outcome']>; forwarded: 'observation' | 'absence' | 'none'; saga: SagaResult | null; nextRetryAt: Date | null };

const OUTCOME = (r: ProviderEffectRetrieval) => r.kind === 'effect_present' ? 'effect_present' as const : r.kind === 'absent_complete' ? 'absent_complete' as const
  : r.kind === 'incomplete' ? 'incomplete' as const : r.kind === 'scope_mismatch' ? 'scope_mismatch' as const
    : r.errorClass === 'retryable' ? 'error_retryable' as const : r.errorClass === 'rate_limited' ? 'error_rate_limited' as const : 'error_permanent' as const;

export class BenefitReconciliationService {
  constructor(private readonly db: Database, private readonly saga: BenefitApplicationSagaService) {}

  async reconcile(intentId: string, ctx: ReconcileContext): Promise<ReconcileResult> {
    const clock = ctx.clock ?? (() => new Date());
    const requiredAbsences = Math.max(ctx.requiredAbsences ?? 2, 2); // never fewer than two: a single query is not proof
    const minGap = Math.max(ctx.minAbsenceGapMs ?? 300_000, 0);
    const inFlightMs = ctx.inFlightWindowMs ?? 120_000;

    // 1. reserve an attempt number under the intent row lock (no lock is held during the network call)
    const started = await this.db.transaction(async tx => {
      const [intent] = await tx.select().from(benefitApplicationIntents).where(eq(benefitApplicationIntents.id, intentId)).for('update');
      if (!intent) return { skip: 'NOT_FOUND' as const };
      if (intent.state === 'reserved') return { skip: 'NOT_ATTEMPTED' as const };
      if (intent.state === 'consumed' || intent.state === 'released') return { skip: 'TERMINAL' as const };
      const startedAt = clock();
      const [open] = await tx.select({ n: sql<number>`count(*)::int` }).from(benefitReconciliationAttempts)
        .where(and(eq(benefitReconciliationAttempts.intentId, intentId), isNull(benefitReconciliationAttempts.outcome), sql`${benefitReconciliationAttempts.startedAt} > ${new Date(startedAt.getTime() - inFlightMs)}`));
      if ((open?.n ?? 0) > 0) return { skip: 'IN_FLIGHT' as const };
      const [last] = await tx.select({ n: benefitReconciliationAttempts.attemptNo }).from(benefitReconciliationAttempts).where(eq(benefitReconciliationAttempts.intentId, intentId)).orderBy(desc(benefitReconciliationAttempts.attemptNo)).limit(1);
      const attemptNo = (last?.n ?? 0) + 1;
      await tx.insert(benefitReconciliationAttempts).values({ intentId, businessId: intent.businessId, attemptNo, reconcileKey: `reconcile:v1:${intentId}:${attemptNo}`, startedAt });
      return { intent, attemptNo, startedAt };
    });
    if ('skip' in started) return { status: 'skipped', reason: started.skip };
    const { intent, attemptNo, startedAt } = started;

    // 2. read-only provider query
    const expected: ExpectedProviderScope = { ...ctx.scope, invoiceRef: intent.invoiceRef, currency: intent.currency, reservationRef: intent.reservationId };
    const retrieval = await retrieveProviderEffect(ctx.reader, expected, ctx.extractor);

    // 3. complete the attempt exactly once, with redacted detail only
    const finishedAt = clock();
    const outcome = OUTCOME(retrieval);
    const nextRetryAt = retrieval.kind === 'error' && retrieval.errorClass !== 'permanent'
      ? new Date(finishedAt.getTime() + nextRetryDelayMs(attemptNo, retrieval.retryAfterMs, ctx.rand)) : null;
    await this.db.update(benefitReconciliationAttempts).set({
      finishedAt, outcome,
      detailCode: retrieval.kind === 'error' ? retrieval.code : retrieval.kind === 'scope_mismatch' || retrieval.kind === 'incomplete' ? retrieval.reason : null,
      httpStatus: retrieval.kind === 'error' ? retrieval.status ?? null : null,
      retryAfterMs: retrieval.kind === 'error' ? retrieval.retryAfterMs ?? null : null,
      nextRetryAt,
      linesInspected: 'linesInspected' in retrieval ? retrieval.linesInspected : null,
      effectCount: retrieval.kind === 'effect_present' ? retrieval.effects.length : retrieval.kind === 'absent_complete' ? 0 : null,
    }).where(and(eq(benefitReconciliationAttempts.intentId, intentId), eq(benefitReconciliationAttempts.attemptNo, attemptNo)));

    // 4. forward only what the evidence supports
    const attemptKey = intent.attemptKey!;
    const obs = toSagaObservation(retrieval, expected);
    if (obs) return { status: 'reconciled', attemptNo, outcome, forwarded: 'observation', saga: await this.saga.recordObservation(intentId, attemptKey, obs, finishedAt), nextRetryAt };
    if (retrieval.kind === 'absent_complete') {
      const recent = await this.db.select().from(benefitReconciliationAttempts).where(eq(benefitReconciliationAttempts.intentId, intentId)).orderBy(desc(benefitReconciliationAttempts.attemptNo)).limit(requiredAbsences);
      const streak = recent.length === requiredAbsences && recent.every(a => a.outcome === 'absent_complete') &&
        recent.every((a, i) => i === recent.length - 1 || a.startedAt.getTime() - recent[i + 1]!.startedAt.getTime() >= minGap) &&
        recent[recent.length - 1]!.startedAt.getTime() >= intent.attemptedAt!.getTime();
      if (streak) return { status: 'reconciled', attemptNo, outcome, forwarded: 'absence', saga: await this.saga.recordObservation(intentId, attemptKey, { status: 'effect_absent', checkedAt: startedAt.getTime() }, finishedAt), nextRetryAt };
    }
    return { status: 'reconciled', attemptNo, outcome, forwarded: 'none', saga: null, nextRetryAt };
  }
}
