/**
 * S4.1 "redacted representative feedback excerpts" / S4.2 "do not send
 * unnecessary personal information, complete identifiers ..." -- strips
 * PII-shaped content from feedback comment text before SummaryService
 * includes it in the Anthropic prompt (summary-generator.ts's buildPrompt).
 * Two independent passes, applied in generateForPeriod's comment-mapping
 * step (this module has no access to -- and doesn't need -- the wider
 * Feedback row):
 *
 *  1. Generic pattern scan (email addresses, phone numbers) -- catches any
 *     identifier a customer typed into free text, not just their own.
 *  2. Exact, case-insensitive match against `knownIdentifiers` -- this
 *     row's own customerName/customerEmail/customerPhone (feedback.ts),
 *     when present. Catches a customer restating their own already-known
 *     contact info in the comment, which the generic patterns above only
 *     partially cover -- a name isn't a "pattern."
 *
 * Deliberately NOT attempted: general name/entity redaction for anyone
 * other than the submitter (e.g. "the manager John was rude"). That needs
 * NER-grade recognition -- a regex or fixed name list can't tell "Maria
 * was fantastic" apart from any other two-word capitalized phrase without
 * an unacceptable false-positive rate -- and running it through another
 * model call would itself be exactly the per-item AI spend S4.2 says to
 * avoid ("Use Workers AI for individual classification and Anthropic only
 * for aggregated reasoning"). A staff member's name surfacing in a
 * recurring-complaint summary is also product-relevant signal a business
 * owner needs, not pure liability the way a phone number is.
 *
 * Precision/recall tradeoff is deliberately recall-leaning, same reasoning
 * feedback/critical-detector.ts's own doc comment already gives for its
 * keyword patterns: an over-eager match just redacts something harmless
 * (an order number swallowed by the phone pattern) to "[phone redacted]"
 * in an executive summary -- a minor quality ding. A missed real phone
 * number is the actual harm this module exists to prevent, so the patterns
 * below favor catching more over matching less.
 */

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Matches the common "3-3-4" North American shape (area code, exchange,
// line number) with an optional leading country code and flexible
// separators (space, dot, dash, or none), with or without parens around
// the area code -- e.g. "(555) 123-4567", "555-123-4567", "+1 555.123.4567",
// "5551234567". Does NOT catch a number given without an area code (e.g.
// "call 555-1234") -- a deliberate boundary, not an oversight: a bare
// 7-digit run has too many non-phone false positives (order numbers,
// confirmation codes) for the marginal recall gain to be worth it.
const PHONE_PATTERN = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

const EMAIL_REDACTED = '[email redacted]';
const PHONE_REDACTED = '[phone redacted]';
const IDENTIFIER_REDACTED = '[redacted]';

/** Escapes regex metacharacters in a raw string value (a name or email can
 * contain `.`, `+`, `(`, etc., all meaningful in a regex otherwise) so it
 * can be safely dropped into `new RegExp(...)` as a literal match. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts one comment string. `knownIdentifiers` should be the same row's
 * own `customerName`/`customerEmail`/`customerPhone` (all optional on
 * `feedback` -- pass whichever are non-null); `null`/`undefined`/blank
 * entries are skipped, not errors.
 */
export function redactComment(comment: string, knownIdentifiers: (string | null | undefined)[] = []): string {
  let result = comment.replace(EMAIL_PATTERN, EMAIL_REDACTED).replace(PHONE_PATTERN, PHONE_REDACTED);

  for (const identifier of knownIdentifiers) {
    const trimmed = identifier?.trim();
    if (!trimmed) continue;
    result = result.replace(new RegExp(escapeForRegex(trimmed), 'gi'), IDENTIFIER_REDACTED);
  }

  return result;
}
