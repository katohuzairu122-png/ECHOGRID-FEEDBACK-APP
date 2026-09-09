import { describe, it, expect } from 'vitest';
import { computeRetryDelaySeconds, BASE_RETRY_DELAY_SECONDS, MAX_RETRY_DELAY_SECONDS } from './backoff';

describe('computeRetryDelaySeconds (S4 roadmap Block 6 -- bounded exponential backoff)', () => {
  it('returns the base delay for the first failed attempt', () => {
    expect(computeRetryDelaySeconds(1)).toBe(BASE_RETRY_DELAY_SECONDS);
  });

  it('doubles for the second failed attempt', () => {
    expect(computeRetryDelaySeconds(2)).toBe(BASE_RETRY_DELAY_SECONDS * 2);
  });

  it('doubles again for the third failed attempt', () => {
    expect(computeRetryDelaySeconds(3)).toBe(BASE_RETRY_DELAY_SECONDS * 4);
  });

  it('keeps growing exponentially right up to the point the cap would take over', () => {
    // With the current 30s base / 300s cap, attempt 4's raw exponential
    // value (30 * 2^3 = 240) is still under the cap -- proves the doubling
    // itself is correct at the boundary, not just for the first couple of
    // attempts where a hardcoded fallback could coincidentally match.
    expect(computeRetryDelaySeconds(4)).toBe(BASE_RETRY_DELAY_SECONDS * 8);
    expect(computeRetryDelaySeconds(4)).toBeLessThan(MAX_RETRY_DELAY_SECONDS);
  });

  it('caps at the max delay once exponential growth would exceed it -- the actual "bounded" guarantee', () => {
    // Raw exponential at attempt 5 (30 * 2^4 = 480) exceeds the 300s cap --
    // this is the one test that actually proves growth is bounded, not just
    // that it doubles.
    expect(computeRetryDelaySeconds(5)).toBe(MAX_RETRY_DELAY_SECONDS);
  });

  it('stays capped for arbitrarily large attempt counts, not just barely over the threshold', () => {
    expect(computeRetryDelaySeconds(10)).toBe(MAX_RETRY_DELAY_SECONDS);
    expect(computeRetryDelaySeconds(50)).toBe(MAX_RETRY_DELAY_SECONDS);
  });

  it('throws a RangeError for attempts < 1, since Cloudflare Queues Message.attempts is always >= 1', () => {
    expect(() => computeRetryDelaySeconds(0)).toThrow(RangeError);
    expect(() => computeRetryDelaySeconds(-1)).toThrow(RangeError);
  });
});
