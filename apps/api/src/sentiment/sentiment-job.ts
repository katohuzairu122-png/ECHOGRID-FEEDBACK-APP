/**
 * Message contract for the `echo-grid-feedback-jobs` queue (binding `JOBS`,
 * provisioned since the platform Foundation but unused until now). A
 * discriminated union on `type` from day one -- even though
 * `classify_feedback` is the only variant that exists -- because this queue
 * is explicitly documented (wrangler.toml) as shared infrastructure for
 * sentiment analysis, notifications, and loyalty recalculation, and every
 * future job type needs a way to be told apart in one consumer handler
 * without a breaking change to the ones already shipped.
 */
export interface ClassifyFeedbackJob {
  type: 'classify_feedback';
  feedbackId: string;
  businessId: string;
}

/**
 * Dates travel as ISO strings, not `Date` objects -- queue messages are
 * JSON-serialized in transit, and `Date` doesn't round-trip through
 * `JSON.stringify`/`parse` (it becomes a string anyway, just without the
 * type system admitting it). SummaryService converts back to `Date` at the
 * boundary where it actually queries the database.
 */
export interface GenerateSummaryJob {
  type: 'generate_summary';
  businessId: string;
  branchId?: string | undefined;
  periodType: 'weekly' | 'monthly';
  periodStart: string;
  periodEnd: string;
}

export type SentimentJob = ClassifyFeedbackJob | GenerateSummaryJob;

/**
 * Enqueues classification for one feedback row. Callers (qr.routes.ts today,
 * a manual reanalyze endpoint below) fire this via `c.executionCtx.waitUntil`
 * so a slow/unavailable queue never delays the customer-facing response --
 * feedback submission succeeds the moment the row is written; classification
 * is best-effort background work layered on top, matching this project's
 * "background processing" performance standard.
 */
export async function enqueueClassification(
  queue: Queue<SentimentJob>,
  feedbackId: string,
  businessId: string,
): Promise<void> {
  await queue.send({ type: 'classify_feedback', feedbackId, businessId });
}

/**
 * Enqueues one summary-generation job. Called both by the manual
 * `POST /analytics/summaries/generate` endpoint (Block 4, an explicit staff
 * action) and by the `scheduled` cron handler (Block 3, automatic
 * weekly/monthly rollups) -- one code path for both triggers so they can
 * never drift in what a "summary generation" job actually contains.
 */
export async function enqueueSummaryGeneration(
  queue: Queue<SentimentJob>,
  input: Omit<GenerateSummaryJob, 'type'>,
): Promise<void> {
  await queue.send({ type: 'generate_summary', ...input });
}
