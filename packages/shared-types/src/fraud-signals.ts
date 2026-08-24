import { z } from 'zod';

/**
 * Staff-facing fraud-signal review queue (Continuing Development Block 5.1,
 * S7.1 minimal manual review). Read/action contract for
 * apps/api/src/fraud/fraud-signal.routes.ts. No request schema needed --
 * the list endpoint takes plain query params (same as branches.ts's own
 * list route), and review/dismiss take no body (the actor comes from auth
 * context, not a payload).
 */
export const fraudSignalSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  branchId: z.uuid(),
  feedbackId: z.uuid().nullable(),
  signalType: z.string(),
  reasonCode: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  status: z.enum(['open', 'reviewed', 'dismissed']),
  // Loosely typed on purpose -- shape varies by signalType (a velocity
  // signal carries counts and a window; a visit-verification signal
  // carries the attempted code), matching fraud_signals' own schema intent
  // (JSONB specifically because no single shape fits every detector). This
  // is the one DTO in this package that doesn't hand-pick every field --
  // review staff need to see whatever a detector actually recorded.
  metadata: z.record(z.string(), z.unknown()).nullable(),
  detectedAt: z.string(),
  reviewedAt: z.string().nullable(),
  // Included here unlike createdBy/updatedBy elsewhere in this package --
  // "who reviewed this" is core information for a review QUEUE (avoiding
  // duplicate staff effort on the same signal), not an internal
  // audit-only detail the way a generic actor id is treated on other DTOs.
  reviewedBy: z.uuid().nullable(),
});

export type FraudSignalDto = z.infer<typeof fraudSignalSchema>;
