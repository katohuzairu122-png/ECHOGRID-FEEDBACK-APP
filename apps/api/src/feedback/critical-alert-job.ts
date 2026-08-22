/**
 * Message contract for escalating an unacknowledged P0_CRITICAL incident --
 * same discriminated-union-on-`type` shape as sentiment-job.ts, sharing the
 * same `echo-grid-feedback-jobs` queue rather than a new one (this is
 * lightweight, bounded background work like every other job type there).
 *
 * The escalation *sweep* (finding which incidents qualify) runs in
 * index.ts's `scheduled` cron handler, matching how that handler already
 * only enqueues work for `generate_summary` rather than doing it inline --
 * this job is the actual per-incident work (re-notify + mark escalated),
 * which gets the queue consumer's existing retry/DLQ safety net for free.
 */
export interface EscalateCriticalIncidentJob {
  type: 'escalate_critical_incident';
  incidentId: string;
  businessId: string;
}

export async function enqueueEscalation(
  queue: Queue<EscalateCriticalIncidentJob>,
  input: Omit<EscalateCriticalIncidentJob, 'type'>,
): Promise<void> {
  await queue.send({ type: 'escalate_critical_incident', ...input });
}
