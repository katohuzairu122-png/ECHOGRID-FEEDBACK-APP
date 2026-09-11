/**
 * Continuing Development S5-C (spec S5.6's "inexpensive near-duplicate
 * scoring" and "repeated-template detection"). Token-set similarity, scored
 * ONLY between submissions that share a device hash.
 *
 * WHY DEVICE-GATED, WHICH THE SPEC DOES NOT ASK FOR
 * Text-similarity-only scoring was built twice and measured twice; both were
 * discarded before shipping. The numbers are recorded in the project doc
 * `s5c-near-duplicate-finding.md`, and the summary is that the two
 * populations invert:
 *
 *   worst honest pair   0.857   ("food was great and service was great",
 *                                versus the same words reordered -- two real
 *                                customers, independently)
 *   weakest attack      0.500   (one template with three slots refilled)
 *
 * No threshold separates those. Short formulaic feedback about one business
 * is INTRINSICALLY near-duplicate: ten words of praise for the same cafe
 * genuinely collide. The information needed to tell a template from a happy
 * regular is not in the text, so no algorithm choice fixes it -- SimHash was
 * rejected first for a related reason (its conventional 3-of-64 threshold
 * assumes hundreds of shingles; a comment has ~10-30, so one changed word
 * flips ~12 bits).
 *
 * Correlating the SUBMITTER is what makes similarity mean something. "Same
 * device, near-identical text" is evidence. "Different devices, similar
 * text" is just people. So the gate, not the algorithm, is the substance of
 * this module -- and it removes the false-positive class that made
 * text-only scoring unusable, because a match now always involves one
 * person's own repeated submissions rather than two strangers who phrased
 * things alike.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH
 * An attacker who rotates device signals defeats the gate entirely. That is
 * accepted: they are then spreading submissions across apparent devices,
 * which is what device/IP velocity (velocity-tracker.ts) and the exact-text
 * hash (text-normalizer.ts) are for. This detector is aimed at the lazy
 * case -- one device, one template, refilled -- and claiming more than that
 * would be dishonest about what a token-set comparison can do.
 *
 * Signal-only, never blocking (S2.9/S2.15), same as every other detector.
 */

export type FraudSeverity = 'low' | 'medium' | 'high';

/**
 * Similarity at or above which two comments from ONE device count as near-
 * duplicates, as Jaccard overlap of their token sets (0 = disjoint,
 * 1 = same words).
 *
 * 0.65 from the measurements: it catches a template with two slots refilled
 * (0.692) and everything more similar, including a straight repost with the
 * words reordered (1.000) and a single word appended (0.917).
 *
 * The residual false-positive class is a regular writing genuinely similar
 * praise on separate visits (measured 0.833). That is tolerated on purpose:
 * because of the device gate it is the same person's own repetition, so no
 * customer is being mistaken for someone else, it is worth a low-severity
 * note next to the cooldown signal that already fires for same-device
 * repeats, and it is exactly the "one reward per qualifying visit" question
 * S5.7 cares about.
 *
 * Retune from production data. Unlike S5-A's length floor, this number was
 * chosen against a hand-built sample, not a real distribution.
 */
export const NEAR_DUPLICATE_MIN_SIMILARITY = 0.65;

/**
 * How many of the device's own recent comments a new submission is compared
 * against.
 *
 * Bounded so the cost of a submit cannot grow with the table. One indexed
 * read plus at most this many set intersections over ~10-30 short tokens
 * each -- arithmetic, no model call, nothing that belongs on a queue. The
 * window is per device rather than per branch, so it is naturally small
 * already: a device with 20 prior comments at one branch is itself the
 * pattern being looked for.
 */
export const NEAR_DUPLICATE_CANDIDATE_LIMIT = 20;

/** Prior near-duplicates from the same device needed before a fraud signal
 * is raised. 1 -- i.e. the second near-identical submission from one device
 * is the first one reported. Lower than S5-A's exact-duplicate threshold of
 * 2 because the device gate has already done most of the filtering: an
 * anonymous exact-text collision between strangers is plausible, one device
 * posting the same thing twice is not an accident in the same way. */
export const NEAR_DUPLICATE_SIGNAL_THRESHOLD = 1;

const MEDIUM_SEVERITY_AT = 3;
const HIGH_SEVERITY_AT = 8;

/**
 * Comparison-specific tokenization: lowercase, strip everything that is not
 * a letter or digit, split, de-duplicate.
 *
 * Separate from feedback/text-normalizer.ts's normalizeFeedbackText, which
 * deliberately does NOT strip punctuation because it backs the stored
 * exact-hash column -- changing it would invalidate every
 * normalized_text_hash already in the table. That gap was not theoretical:
 * under the SimHash attempt, a punctuation-only difference measured FURTHER
 * apart (18 bits) than a real template (12), purely because the tokens
 * differed. Punctuation must be gone before anything similarity-based
 * compares two comments.
 *
 * Unicode-aware (\p{L}/\p{N}) rather than [a-z0-9]: this app ships in
 * en/es/fr, and stripping accented letters would mangle French and Spanish
 * comments into different token sets than their unaccented twins.
 */
export function comparisonTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
}

/**
 * Jaccard overlap: shared tokens over total distinct tokens. Two empty sets
 * score 0, not 1 -- "no words in common" is the honest answer for text that
 * had no comparable words at all, and scoring it 1 would make every
 * comment-less submission a near-duplicate of every other.
 *
 * Set-based, so word ORDER is discarded. That is correct here rather than a
 * limitation: a repost with the words shuffled is exactly the evasion this
 * should see through, and it scored 1.000 where SimHash's order-sensitive
 * bigrams put it 15 bits away.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  // Iterate the smaller set: the number of lookups is then bounded by the
  // shorter comment rather than the longer one.
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

export function isNearDuplicate(a: Set<string>, b: Set<string>): boolean {
  return jaccardSimilarity(a, b) >= NEAR_DUPLICATE_MIN_SIMILARITY;
}

/**
 * How many of this device's recent comments are near-duplicates of the new
 * one.
 *
 * A count, not a boolean, for the same reason S5-A counts exact duplicates:
 * one is a coincidence, twenty is a campaign, and the fraud signal's
 * severity should be able to say which. Tokenizes the new comment once and
 * reuses it across every candidate.
 */
export function countNearDuplicates(
  newComment: string | null | undefined,
  candidateComments: readonly (string | null)[],
): number {
  const tokens = comparisonTokens(newComment);
  if (tokens.size === 0) return 0;

  let matches = 0;
  for (const candidate of candidateComments) {
    if (isNearDuplicate(tokens, comparisonTokens(candidate))) matches++;
  }
  return matches;
}

export function shouldRaiseNearDuplicateSignal(nearDuplicateCount: number): boolean {
  return nearDuplicateCount >= NEAR_DUPLICATE_SIGNAL_THRESHOLD;
}

/** Count-driven only, matching duplicate-text-signal.ts: rating and
 * sentiment stay out of it, so a flood of identical five-star praise scores
 * exactly like a flood of identical complaints. */
export function nearDuplicateSeverity(nearDuplicateCount: number): FraudSeverity {
  if (nearDuplicateCount >= HIGH_SEVERITY_AT) return 'high';
  if (nearDuplicateCount >= MEDIUM_SEVERITY_AT) return 'medium';
  return 'low';
}

export const NEAR_DUPLICATE_SIGNAL_TYPE = 'near_duplicate';
export const NEAR_DUPLICATE_REASON_CODE = 'near_duplicate_text_same_device';
