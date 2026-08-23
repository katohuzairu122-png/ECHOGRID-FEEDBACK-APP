/**
 * Level 1 deterministic processing (Automated Feedback Sorting, Continuing
 * Development spec S3.1) -- generates a normalized-text hash so
 * FeedbackService.submit can detect an exact-text repeat at the same branch
 * synchronously, with no model call and no async queue round trip (same
 * "never wait for Anthropic processing" reasoning critical-detector.ts
 * already documents for P0 detection).
 *
 * Deliberately narrow: this only ever catches an EXACT normalized match.
 * Near-duplicate scoring, submission frequency/velocity, cooldowns, and any
 * fraud consequence (reason codes, manual-review routing, reward blocking)
 * are explicitly later work -- spec S5.6 / Continuing Development roadmap
 * Block 5 -- once the fraud-signal schema and reward/campaign model exist.
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
