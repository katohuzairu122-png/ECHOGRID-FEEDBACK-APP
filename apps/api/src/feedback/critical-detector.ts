/**
 * Level 1 deterministic processing (Automated Feedback Sorting) -- a pure,
 * synchronous keyword scan run inline in FeedbackService.submit(), never
 * queued and never dependent on Workers AI or Anthropic. Exists specifically
 * so a credible safety emergency gets P0_CRITICAL status and an incident
 * record the instant the row is stored, not whenever the async
 * classification queue happens to drain.
 *
 * Deliberately keyword/regex-based, not a model call: the spec requires this
 * step to "never wait for Anthropic processing," and a synchronous Workers
 * AI call on the hot submit path would add real latency (and a real cost)
 * to every single submission just to catch the rare P0 case. Precision over
 * recall is the wrong tradeoff here (a missed true emergency is far worse
 * than an over-eager false positive that a manager dismisses in seconds), so
 * patterns are intentionally a little broad -- Level 2's AI classification
 * pass still runs afterward for everything else the async pipeline covers.
 *
 * This does NOT contact police, hospitals, or emergency services -- see
 * qr.routes.ts's alert wiring. It only elevates urgency and creates an
 * auditable record for a human to act on.
 */

export type CriticalSignal =
  | 'immediate_danger'
  | 'fire'
  | 'assault'
  | 'food_poisoning'
  | 'severe_allergic_reaction'
  | 'medical_emergency'
  | 'active_fraud'
  | 'security_incident';

const SIGNAL_PATTERNS: Record<CriticalSignal, RegExp[]> = {
  immediate_danger: [/\bin (immediate )?danger\b/i, /\bsomeone(?:'s| is) going to get hurt\b/i, /\btrapped inside\b/i],
  // \bfire\b alone is deliberately included, not just longer phrases -- word
  // boundaries already keep it from matching "fired"/"campfire"/"misfire"
  // (no boundary between adjacent letters), and per this module's own
  // recall-over-precision reasoning above, a bare "there's a fire"/"FIRE!"
  // report is exactly the kind of true positive a narrower phrase-only
  // pattern would risk missing.
  fire: [/\bfire\b/i, /\bsmells? like (gas|smoke)\b/i, /\bbuilding is burning\b/i],
  assault: [
    /\bassaulted\b/i,
    /\bwas (attacked|punched|hit|groped)\b/i,
    /\bsexual(ly)? assault(ed)?\b/i,
    /\bthreatened (me|us) with a (knife|gun|weapon)\b/i,
  ],
  food_poisoning: [/\bfood poisoning\b/i, /\b(vomit(ing|ed)?|threw up) after eating\b/i, /\bviolently ill after (eating|the meal)\b/i],
  severe_allergic_reaction: [
    /\banaphylaxis\b/i,
    /\banaphylactic\b/i,
    /\ballergic reaction\b.*\b(can'?t breathe|throat (closing|swelling))\b/i,
    /\bneeds? (an |the )?epipen\b/i,
  ],
  medical_emergency: [
    /\bheart attack\b/i,
    /\bhaving a seizure\b/i,
    /\bunconscious\b/i,
    /\bnot breathing\b/i,
    /\bcall(ed)? an ambulance\b/i,
    /\bcollapsed\b/i,
  ],
  active_fraud: [
    /\bstole my (card|wallet|money)\b/i,
    /\bfraudulent charge\b/i,
    /\bcard (was )?skimmed\b/i,
    /\bidentity theft\b/i,
    /\bcharged me (without|twice)\b.*\bfraud/i,
  ],
  security_incident: [
    /\b(has|had|has a|saw a) (gun|knife|weapon)\b/i,
    /\bbreak-?in\b/i,
    /\bbeing robbed\b/i,
    /\bactive shooter\b/i,
  ],
};

export interface CriticalDetectionResult {
  isCritical: boolean;
  matchedSignals: CriticalSignal[];
}

/** Scans free-text feedback for credible safety/fraud emergency language.
 * Rating alone is never enough signal (a 1-star rating is just a bad
 * experience, not an emergency), so a missing/empty comment always returns
 * no match. */
export function detectCriticalSignals(comment: string | null | undefined): CriticalDetectionResult {
  if (!comment || !comment.trim()) {
    return { isCritical: false, matchedSignals: [] };
  }

  const matched: CriticalSignal[] = [];
  for (const [signal, patterns] of Object.entries(SIGNAL_PATTERNS) as [CriticalSignal, RegExp[]][]) {
    if (patterns.some((pattern) => pattern.test(comment))) {
      matched.push(signal);
    }
  }

  return { isCritical: matched.length > 0, matchedSignals: matched };
}
