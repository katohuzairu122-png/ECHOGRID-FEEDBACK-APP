import { describe, it, expect } from 'vitest';
import {
  shouldRaiseDuplicateTextSignal,
  duplicateTextSeverity,
  DUPLICATE_SIGNAL_THRESHOLD,
} from './duplicate-text-signal';

describe('shouldRaiseDuplicateTextSignal', () => {
  it('stays silent for a first-time comment', () => {
    expect(shouldRaiseDuplicateTextSignal(0)).toBe(false);
  });

  it('stays silent for a single repeat', () => {
    // The double-tap case: a stalled connection on a mobile QR flow, not
    // fraud. Flagging it would fill the review queue with the platform's own
    // network behaviour.
    expect(shouldRaiseDuplicateTextSignal(1)).toBe(false);
  });

  it('raises at exactly the threshold and above', () => {
    // Pinned to the constant so retuning the threshold changes one number
    // rather than the meaning of these tests.
    expect(shouldRaiseDuplicateTextSignal(DUPLICATE_SIGNAL_THRESHOLD)).toBe(true);
    expect(shouldRaiseDuplicateTextSignal(DUPLICATE_SIGNAL_THRESHOLD + 1)).toBe(true);
    expect(shouldRaiseDuplicateTextSignal(DUPLICATE_SIGNAL_THRESHOLD - 1)).toBe(false);
  });
});

describe('duplicateTextSeverity', () => {
  it('escalates with the count', () => {
    expect(duplicateTextSeverity(2)).toBe('low');
    expect(duplicateTextSeverity(4)).toBe('low');
    expect(duplicateTextSeverity(5)).toBe('medium');
    expect(duplicateTextSeverity(9)).toBe('medium');
    expect(duplicateTextSeverity(10)).toBe('high');
    expect(duplicateTextSeverity(500)).toBe('high');
  });

  it('never returns a value outside the fraud_signals severity CHECK constraint', () => {
    // The DB constraint is IN ('low','medium','high'); a value outside it
    // would fail the INSERT at runtime, where no typecheck would catch it.
    const allowed = ['low', 'medium', 'high'];
    for (let count = 0; count <= 40; count++) {
      expect(allowed).toContain(duplicateTextSeverity(count));
    }
  });

  it('is monotonic -- more copies can never mean lower severity', () => {
    const rank = { low: 0, medium: 1, high: 2 };
    let previous = -1;
    for (let count = 0; count <= 40; count++) {
      const current = rank[duplicateTextSeverity(count)];
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
