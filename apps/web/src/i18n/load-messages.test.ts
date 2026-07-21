import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES } from '@echo-grid-feedback/shared-types';
import { loadMessages } from './load-messages';

const EXPECTED_NAMESPACES = [
  'common',
  'dashboard',
  'auth',
  'branches',
  'feedback',
  'loyalty',
  'analytics',
  'notifications',
  'platform',
];

/**
 * loadMessages dynamically imports every namespace's messages/<locale>/*.json
 * file (i18n & Multi-Currency Block 2). A missing file, a typo'd namespace
 * name, or invalid JSON in any of the 27 files this app now ships (9
 * namespaces x 3 locales) would only surface at request time in the real
 * app -- this exercises the exact same import path for every supported
 * locale up front, so a broken file fails a test instead of a page.
 */
describe('loadMessages', () => {
  it.each(SUPPORTED_LOCALES)('loads every expected namespace for locale "%s"', async (locale) => {
    const messages = await loadMessages(locale);

    for (const namespace of EXPECTED_NAMESPACES) {
      expect(messages).toHaveProperty(namespace);
      expect(typeof messages[namespace]).toBe('object');
      expect(messages[namespace]).not.toBeNull();
    }
  });

  it('returns no namespaces beyond the expected set', async () => {
    const messages = await loadMessages(SUPPORTED_LOCALES[0]);
    expect(Object.keys(messages).sort()).toEqual([...EXPECTED_NAMESPACES].sort());
  });
});
