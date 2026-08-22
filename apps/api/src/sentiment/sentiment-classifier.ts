// 'unknown' is enumerated (feedback-classification.ts's SENTIMENT_VALUES,
// the DB CHECK) but never emitted by bucket() below -- a classification
// failure leaves `sentiment` NULL, not 'unknown' (see
// SentimentService.classifyAndStore's catch branch), so analysisStatus
// stays the single authoritative "did this row get classified" signal
// instead of two overlapping ones. 'unknown' exists as a legal value for a
// future manual-override or ambiguous-case path, same forward-compatible
// treatment notifications.ts's 'push' channel already gets in this codebase.
export type SentimentLabel = 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive' | 'unknown';

export interface SentimentResult {
  sentiment: SentimentLabel;
  /** -1 (most negative) .. 1 (most positive). */
  score: number;
}

// A binary sentiment model, not a 3-class one -- Workers AI's catalog has no
// production-ready 3-class (positive/neutral/negative) text classifier as of
// this writing. Neutral is derived instead (see NEUTRAL_BAND below) rather
// than left unsupported, which keeps the platform on a zero-new-secret,
// edge-native model instead of reaching for a heavier external API just for
// per-item classification (the LLM-backed path is reserved for Block 3's
// prose summaries, where per-class nuance actually matters).
const MODEL = '@cf/huggingface/distilbert-sst-2-int8';

// A raw binary score sitting close to 0.5 confidence reflects the model
// being unsure, not a strong opinion either way -- bucketing that as
// "neutral" is a more honest signal to show a business than forcing every
// review into positive/negative. 0.15 is a starting estimate (not derived
// from labeled platform data yet); revisit once real classification volume
// exists to tune against actual business feedback on accuracy.
const NEUTRAL_BAND = 0.15;

// Splits positive/negative further into the "very_" variants once the model
// is confident, not just leaning -- 0.7 is the same "starting estimate, not
// yet tuned against labeled platform data" caveat as NEUTRAL_BAND above.
const STRONG_BAND = 0.7;

interface WorkersAiTextClassificationResult {
  label: string;
  score: number;
}

/**
 * Thin wrapper around the Workers AI binding -- kept as its own class (not
 * inlined in SentimentService) so the model choice, score-signing, and
 * neutral-bucketing logic are unit-testable in isolation from the repository
 * plumbing around them, and swappable later without touching the service.
 */
export class SentimentClassifier {
  constructor(private readonly ai: Ai) {}

  /**
   * Classifies free-text comment content. Throws on an empty/malformed model
   * response rather than silently guessing -- the caller (SentimentService)
   * is responsible for catching this and marking the feedback row
   * `analysisStatus: 'failed'` instead of leaving a wrong sentiment stored.
   */
  async classifyText(text: string): Promise<SentimentResult> {
    const output = (await this.ai.run(MODEL, {
      text,
    })) as WorkersAiTextClassificationResult[] | undefined;

    const top = Array.isArray(output) ? output[0] : undefined;
    if (!top || typeof top.score !== 'number') {
      throw new Error('Workers AI returned an unexpected classification response.');
    }

    // Model output is a confidence in [0, 1] for whichever label won; sign it
    // so POSITIVE and NEGATIVE share one continuous -1..1 scale instead of
    // two separate unsigned confidences a caller would have to reconcile.
    const signedScore = top.label.toUpperCase() === 'POSITIVE' ? top.score : -top.score;
    return this.bucket(signedScore);
  }

  /**
   * Deterministic, AI-free fallback for feedback with no comment text --
   * a 1-5 star rating alone still carries a clear sentiment signal, and
   * spending a Workers AI inference on nothing but a number would be pure
   * waste. Uses the same -1..1 scale and bucketing as classifyText so the
   * two paths are indistinguishable to every downstream consumer.
   */
  classifyRating(rating: number): SentimentResult {
    const normalized = (rating - 3) / 2; // 1->-1, 2->-0.5, 3->0, 4->0.5, 5->1
    return this.bucket(normalized);
  }

  private bucket(score: number): SentimentResult {
    const clamped = Math.max(-1, Math.min(1, score));
    let sentiment: SentimentLabel;
    if (clamped > STRONG_BAND) sentiment = 'very_positive';
    else if (clamped > NEUTRAL_BAND) sentiment = 'positive';
    else if (clamped < -STRONG_BAND) sentiment = 'very_negative';
    else if (clamped < -NEUTRAL_BAND) sentiment = 'negative';
    else sentiment = 'neutral';
    return { sentiment, score: Number(clamped.toFixed(4)) };
  }
}
