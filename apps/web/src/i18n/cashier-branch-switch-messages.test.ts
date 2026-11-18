import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** CASHIER-AUTH-02C: the branch switcher text exists, with identical keys and placeholders, in every supported language. */
const read = (locale: string) =>
  (JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/cashier.json`), 'utf8')) as { branchSwitch: Record<string, string> }).branchSwitch;
const locales = ['en', 'fr', 'es', 'ar'] as const;

describe('cashier.branchSwitch messages', () => {
  const en = read('en');
  it.each(locales)('%s has exactly the English keys, all non-empty', (locale) => {
    const messages = read(locale);
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(messages)) expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
  });
  it.each(locales)('%s keeps the {branch} placeholder in the two messages that use it, and nowhere else', (locale) => {
    const messages = read(locale);
    for (const [key, value] of Object.entries(messages)) {
      expect(value.includes('{branch}'), `${locale}.${key}`).toBe(key === 'success' || key === 'noChange');
    }
  });
  it('the translations are genuinely translated, not copies of English', () => {
    for (const locale of ['fr', 'es', 'ar'] as const) expect(read(locale).button).not.toBe(en.button);
  });
});
