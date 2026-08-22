import type { FeedbackCategory, Sentiment, Urgency } from '@echo-grid-feedback/shared-types';

/**
 * Level 2 cheap classification (Automated Feedback Sorting) -- category and
 * urgency, run from the same async queue job that already does sentiment
 * (SentimentService.classifyAndStore). Deterministic keyword matching, not
 * a model call: unlike sentiment (where Workers AI's binary classifier adds
 * real signal over a bare rating), a decent category taxonomy is well
 * served by keyword matching at zero marginal cost per item, keeping this
 * platform's "low-cost AI processing" principle intact -- the LLM-backed
 * path stays reserved for aggregated period summaries (summary-generator.ts),
 * never per-item classification.
 *
 * P0_CRITICAL is deliberately never assigned here -- that's Level 1's job
 * (critical-detector.ts), which already runs synchronously at submission
 * time. This module only ever produces P1-P3.
 */

interface CategoryRule {
  category: FeedbackCategory;
  patterns: RegExp[];
}

// Checked in order -- a comment can plausibly match more than one rule
// (e.g. "the food was cold and pricey" hits both product_quality and
// pricing), and the first match wins. Ordered roughly most-specific-and-
// actionable first, so an operational category is preferred over a vaguer
// one when both could apply.
const CATEGORY_RULES: CategoryRule[] = [
  { category: 'safety', patterns: [/\bunsafe\b/i, /\bhazard/i, /\bslippery floor\b/i, /\btripped\b/i, /\binjur(y|ed)\b/i] },
  {
    category: 'staff_conduct',
    patterns: [/\b(staff|employee|waiter|waitress|server|manager|cashier)\b.*\b(rude|unhelpful|unprofessional|dismissive)\b/i, /\bignored (me|us)\b/i, /\byelled at (me|us)\b/i],
  },
  { category: 'cleanliness', patterns: [/\bdirty\b/i, /\bfilthy\b/i, /\bunclean\b/i, /\bsmell(ed|s)? (bad|awful)\b/i, /\bgrimy\b/i, /\bmess(y)?\b/i] },
  { category: 'waiting_time', patterns: [/\bwait(ed|ing)? (\d+\s*(minutes?|mins?|hours?)|too long|forever)\b/i, /\bslow service\b/i, /\blong (line|queue)\b/i] },
  { category: 'pricing', patterns: [/\b(too )?expensive\b/i, /\boverpriced\b/i, /\bpric(e|ey|ing)\b/i, /\brip[- ]?off\b/i] },
  { category: 'payment', patterns: [/\bcard (declined|didn'?t work)\b/i, /\bovercharged\b/i, /\bbilling (error|mistake)\b/i, /\bwrong (amount|total) charged\b/i] },
  { category: 'delivery', patterns: [/\bdeliver(y|ed)? (late|never arrived|wrong)\b/i, /\bcourier\b/i, /\border (never|didn'?t) arriv/i] },
  { category: 'accessibility', patterns: [/\bwheelchair\b/i, /\baccessib(le|ility)\b/i, /\bno ramp\b/i, /\bdisabled (parking|access)\b/i] },
  { category: 'facilities', patterns: [/\bbathroom\b/i, /\brestroom\b/i, /\bparking\b/i, /\bair conditioning\b/i, /\bfacilit(y|ies)\b/i, /\bbroken (chair|table|equipment)\b/i] },
  { category: 'loyalty_or_reward', patterns: [/\b(points|reward|voucher|redeem|loyalty)\b/i] },
  { category: 'service_quality', patterns: [/\bservice\b/i, /\bstaff\b/i] },
  { category: 'product_quality', patterns: [/\b(food|meal|dish|product|item) (was|is|tasted)\b/i, /\bquality\b/i, /\bcold food\b/i, /\bstale\b/i, /\bundercooked\b/i] },
];

/** Keyword rules first; if none match, falls back to a rating-derived
 * generic bucket (compliment/complaint/suggestion) rather than leaving
 * category NULL for every comment a keyword rule doesn't recognize --
 * 'other' is reserved for the no-comment case, where there is genuinely no
 * text to infer anything from. */
export function classifyCategory(comment: string | null | undefined, rating: number): FeedbackCategory {
  const trimmed = comment?.trim();
  if (!trimmed) return 'other';

  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(trimmed))) {
      return rule.category;
    }
  }

  if (rating >= 4) return 'compliment';
  if (rating <= 2) return 'complaint';
  return 'suggestion';
}

/**
 * P1-P3 only (see module doc comment for why P0 never appears here).
 * `safety` is elevated to P1_HIGH even at a middling rating -- a safety
 * mention that Level 1 didn't already judge P0_CRITICAL (e.g. "the floor
 * was a bit slippery near the entrance" vs. an actual injury report) still
 * deserves faster attention than an ordinary complaint.
 */
export function classifyUrgency(rating: number, sentiment: Sentiment, category: FeedbackCategory): Urgency {
  if (category === 'safety') return 'P1_HIGH';
  if (rating <= 2 || sentiment === 'very_negative' || sentiment === 'negative') return 'P1_HIGH';
  if (rating === 3 || sentiment === 'neutral' || sentiment === 'unknown') return 'P2_NORMAL';
  return 'P3_LOW';
}
