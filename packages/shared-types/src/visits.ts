import { z } from 'zod';

/**
 * Staff-issued visit-session contract (Continuing Development Block 4.3.1,
 * S5.3). Request/response shapes for POST /branches/:branchId/visit-sessions
 * and its revoke sibling -- see apps/api/src/visits/visit-session.routes.ts.
 *
 * No customer-facing schema here yet -- Block 4.3.2 adds an optional
 * `visitProof` field to submitFeedbackSchema/checkinSchema (feedback.ts/
 * loyalty.ts) rather than a new schema in this file, matching how
 * deviceSignal (Block 4.1) was added directly to those two existing
 * contracts instead of introducing a parallel one.
 */

/**
 * ttlSeconds is capped at 86400 (24h) as a sanity bound, not a spec
 * requirement -- S5.3 names no maximum. Generous enough for a table
 * session (hours) and a one-time token (minutes) alike; guards against an
 * accidental wildly-wrong value (e.g. a unit mix-up) rather than
 * restricting a legitimate staff choice, the same spirit as
 * recordPurchaseSchema's purchaseAmount cap in loyalty.ts.
 */
export const issueVisitSessionSchema = z.object({
  ttlSeconds: z.number().int().positive().max(86400),
  // Omitted or absent -- a table session (unlimited uses until expiresAt).
  // A positive integer -- a one-time-or-N-time visit token. See
  // db/schema/visit-sessions.ts's own doc comment for why this is one
  // field, not two schemas.
  maxUses: z.number().int().positive().optional(),
});

export type IssueVisitSessionInput = z.infer<typeof issueVisitSessionSchema>;

/**
 * Hand-picked, not inferred from the Drizzle row -- same reasoning
 * branches.ts's own branchSchema doc comment gives: this package must never
 * import from apps/api, and internal/audit columns (createdBy, updatedAt,
 * updatedBy, isDeleted, deletedAt, deletedBy) are deliberately never
 * exposed, matching every other DTO in this file's siblings. `code` IS
 * included -- unlike a QR token (always re-signed fresh, never the point of
 * "issue" alone), the session code is the entire deliverable of issuing one.
 */
export const visitSessionSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  branchId: z.uuid(),
  code: z.string(),
  status: z.enum(['active', 'revoked']),
  expiresAt: z.string(),
  maxUses: z.number().nullable(),
  useCount: z.number(),
  createdAt: z.string(),
});

export type VisitSessionDto = z.infer<typeof visitSessionSchema>;
