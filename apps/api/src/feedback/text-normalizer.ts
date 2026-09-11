/**
 * Level 1 deterministic processing (Automated Feedback Sorting, Continuing
 * Development spec S3.1) -- generates a normalized-text hash so
 * FeedbackService.submit can detect an exact-text repeat at the same branch
 * synchronously, with no model call and no async queue round trip (same
 * "never wait for Anthropic processing" reasoning critical-detector.ts
 * already documents for P0 detection).
 *
 * Deliberately narrow: this only ever catches an EXACT normalized match.
 * Near-duplicate scoring and any fraud consequence (reason codes,
 * manual-review routing, reward blocking) are still later work -- spec
 * S5.6, Continuing Development blocks S5-B and S5-C. Submission frequency
 * IS now counted (S5-A): see FeedbackService.submit and
 * FeedbackRepository.countByNormalizedHash.
 * (Named in full: this codebase already uses bare "Block N" elsewhere for
 * the original build's own, different numbering.) This module only
 * ever answers "have we seen this exact text at this branch before," and
 * FeedbackService only ever records that fact; it never rejects or alters a
 * submission, matching S2.9/S2.15's "never lose real customer feedback."
 */

/**
 * Trim, lowercase, and collapse internal whitespace to single spaces.
 * Deliberately simple -- no punctuation stripping or stemming. The goal is
 * to stop trivial formatting differences (extra spaces, a trailing newline
 * from a mobile keyboard, case) from hiding an otherwise-identical
 * resubmission, not to catch paraphrases -- a hash can only ever do exact
 * matching; paraphrase-level similarity is S5.6's future near-duplicate
 * *scoring*, a different technique entirely.
 *
 * Returns null for empty/whitespace-only input -- a bare star rating with no
 * comment has no text to hash, and two customers who both leave no comment
 * are not "duplicates" of each other.
 */
export function normalizeFeedbackText(comment: string | null | undefined): string | null {
  if (!comment) return null;
  const collapsed = comment.trim().toLowerCase().replace(/\s+/g, ' ');
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Continuing Development S5-A. Minimum normalized length before a comment is
 * distinctive enough that two identical copies are evidence of anything.
 *
 * This is spec S5.6's "protection against rejecting legitimate short common
 * phrases", and without it exact-hash matching is actively wrong: "Great
 * service!" normalizes to 13 characters, so the second honest customer to
 * write it at a branch collides with the first. Hashing is skipped entirely
 * below this floor rather than hashing-then-ignoring, so no later consumer
 * can rediscover the column and draw the same false conclusion -- a stored
 * `normalizedTextHash` now means "this text was distinctive enough to
 * compare", which is a property worth being able to rely on.
 *
 * 20 characters, chosen conservatively: it clears the common one- and
 * two-word pleasantries ("great service", "very good, thanks", "loved it")
 * while a genuine complaint or templated bot submission is comfortably
 * longer. Erring long is the cheap direction -- a missed duplicate is still
 * covered by device/IP velocity (fraud/velocity-tracker.ts), whereas a false
 * one accuses a real customer of fraud for praising the business.
 *
 * Worth re-deriving from real comment-length distribution once there is
 * enough production data to look at; this is a defensible default, not a
 * measured one.
 */
export const MIN_DISTINCTIVE_LENGTH = 20;

/**
 * Kept separate from normalizeFeedbackText rather than folded into it:
 * normalization answers "what is the comparable form of this text", this
 * answers "is comparing it meaningful at all". Collapsing the two would mean
 * a function called `normalize` silently applying a fraud policy, and would
 * leave no way to normalize text for any other purpose without inheriting
 * that policy.
 *
 * A type predicate so callers get `string` narrowing straight into
 * hashNormalizedText without a non-null assertion.
 */
export function isDistinctiveEnoughToCompare(normalized: string | null): normalized is string {
  return normalized !== null && normalized.length >= MIN_DISTINCTIVE_LENGTH;
}

/**
 * Content-addressing hash, not a secret -- same SHA-256-via-Web-Crypto
 * pattern as auth/token-hash.ts, for the same underlying reason: Workers-
 * runtime compatible, and there is no dictionary-attack concern for either
 * use. There, the input is already high-entropy; here, the hash isn't
 * protecting anything at all -- it's purely an equality-comparison
 * shortcut so the duplicate lookup can use a plain indexed `=` instead of
 * comparing full comment text row by row.
 */
export async function hashNormalizedText(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
