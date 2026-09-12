import { describe, it, expect } from 'vitest';
import { useFormatter } from 'next-intl';
import { renderWithIntl } from '@/test-utils';
import { formats } from './formats';

/**
 * The regression guard this codebase did not have.
 *
 * Before this file, `test-utils.tsx`'s provider passed no `formats`, so every
 * `format.dateTime(d, 'short')` in the suite logged
 * `IntlError: MISSING_FORMAT: Format 'short' is not available` and fell back
 * to `String(date)`. Two things followed from that, both bad:
 *
 *  1. Tests that render dates (feedback-inbox-list.test.tsx among them)
 *     asserted against a rendering the real app never produces.
 *  2. DELETING 'short' from i18n/formats.ts would have changed nothing about
 *     the test output. 18 call sites depended on a preset no test could
 *     prove existed.
 *
 * These tests fail loudly in both directions: if the preset disappears from
 * formats.ts, or if a provider stops forwarding the object.
 */

// Fixed, mid-afternoon UTC -- far enough from midnight that no timezone
// handling can roll the DATE over and make an assertion ambiguous.
const FIXED = new Date('2026-08-23T14:30:00.000Z');

function DateProbe({ preset }: { preset: 'short' | 'shortDateTime' }) {
  const format = useFormatter();
  return <span data-testid="out">{format.dateTime(FIXED, preset)}</span>;
}

/**
 * Scoped to its own container and unmounted before returning, rather than
 * queried off the global `screen`: one test below renders BOTH presets, and
 * a global query would then find two matching nodes and throw instead of
 * comparing them.
 */
function renderPreset(preset: 'short' | 'shortDateTime'): string {
  const { container, unmount } = renderWithIntl(<DateProbe preset={preset} />);
  const text = container.querySelector('[data-testid="out"]')?.textContent ?? '';
  unmount();
  return text;
}

describe('named dateTime formats', () => {
  it("'short' renders a real medium-style date, not next-intl's String(date) fallback", () => {
    const out = renderPreset('short');

    // Accepts either English ordering -- the point is that Intl formatted it
    // at all, not which regional convention the runtime's ICU data picked.
    expect(out).toMatch(/(Aug(ust)?\s+23,?\s+2026)|(23\s+Aug(ust)?\s+2026)/);

    // The fallback's signature. String(date) renders
    // "Sun Aug 23 2026 14:30:00 GMT+0000 (Coordinated Universal Time)" --
    // which also contains "Aug" and "2026", so the assertion above alone
    // would NOT catch a missing format. These two do.
    expect(out).not.toMatch(/GMT|Coordinated Universal Time/);
    expect(out).not.toContain(':');
  });

  it("'shortDateTime' renders the date AND a time -- the notification-log preset", () => {
    const out = renderPreset('shortDateTime');

    expect(out).toMatch(/(Aug(ust)?\s+23,?\s+2026)|(23\s+Aug(ust)?\s+2026)/);
    // A time component is present (any locale renders it with a separator),
    // which is the entire difference from 'short' above.
    expect(out).toContain(':');
    expect(out).not.toMatch(/GMT|Coordinated Universal Time/);
  });

  it("'short' and 'shortDateTime' are genuinely different presets", () => {
    // Guards the copy-paste failure where both entries end up identical --
    // each assertion above would still pass, since both would then render a
    // valid formatted date.
    expect(renderPreset('short')).not.toEqual(renderPreset('shortDateTime'));
  });

  it('exports exactly the presets the app calls by name', () => {
    // A structural check, cheap and explicit: these two strings appear at 18
    // call sites across dashboard, platform, loyalty and analytics pages.
    // Renaming one here without updating them would otherwise surface only
    // as MISSING_FORMAT noise in a browser console.
    expect(Object.keys(formats.dateTime).sort()).toEqual(['short', 'shortDateTime']);
  });

  it('is timezone-pinned, so a date assertion means the same thing on every machine', () => {
    // renderWithIntl supplies DEFAULT_TIMEZONE. Without it next-intl falls
    // back to the MACHINE's zone, and a UTC-afternoon fixture could render as
    // the 23rd locally and the 24th in CI (or the reverse) with nothing about
    // the code having changed.
    const out = renderPreset('short');
    expect(out).toContain('23');
    expect(out).not.toContain('24');
  });
});
