/**
 * Human-typeable code a customer enters to prove a real visit before their
 * feedback submission or loyalty check-in counts toward anything reward-
 * eligible (Continuing Development Block 4.2, S5.3).
 *
 * A deliberate PARALLEL implementation, not a shared import of
 * loyalty/redemption-code.ts's generateRedemptionCode -- same shape
 * (crypto.getRandomValues over an ambiguity-free alphabet), but a distinct
 * function for a distinct identity, matching this codebase's existing
 * precedent for structurally-similar-but-conceptually-distinct secrets/codes
 * (e.g. CUSTOMER_JWT_SECRET staying separate from the staff JWT secrets
 * rather than being reused). A redemption code is read off a staff-facing
 * screen and typed by STAFF into a POS/dashboard; a visit-session code is
 * shown to a CUSTOMER (a table tent, a receipt, a staff handoff) and typed
 * by the customer on their own phone -- different audiences, different
 * legibility/brevity tradeoffs, and no reason a future change to one code's
 * length/alphabet should ever need to reason about the other's callers.
 *
 * Six characters, not eight -- redemption codes are typed once, by a staff
 * member already trained on the flow; visit-session codes are typed by an
 * anonymous customer on a phone keyboard, so shorter is worth the slightly
 * smaller keyspace. Same visually-ambiguous-character exclusion as
 * redemption-code.ts (0/O, 1/I/L) for the same reason: a misread code should
 * fail loudly (session not found) rather than silently apply to the wrong
 * session.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function generateVisitSessionCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return code;
}
