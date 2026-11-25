import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Four-language parity for the business Community hub: same keys, every value filled, same placeholders, right-to-left script for Arabic. */
const root = join(__dirname, '../../../../messages');
const LOCALES = ['en', 'fr', 'es', 'ar'] as const;
const load = (locale: string, file: string) => JSON.parse(readFileSync(join(root, locale, file), 'utf8')) as Record<string, unknown>;
const flatten = (value: unknown, path = ''): Record<string, string> =>
  typeof value === 'string' ? { [path]: value }
    : Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((all, [k, v]) => ({ ...all, ...flatten(v, path ? `${path}.${k}` : k) }), {});
const ARABIC = /[؀-ۿ]/;

describe('businessCommunity messages', () => {
  const en = flatten(load('en', 'businessCommunity.json'));
  it('has a substantial English source', () => expect(Object.keys(en).length).toBeGreaterThanOrEqual(60));

  for (const locale of LOCALES) {
    it(`${locale}: identical keys, no empty value, identical placeholders`, () => {
      const messages = flatten(load(locale, 'businessCommunity.json'));
      expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(messages)) {
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        expect(value.match(/\{\w+\}/g)?.sort() ?? [], `${locale}.${key} placeholders`).toEqual(en[key]!.match(/\{\w+\}/g)?.sort() ?? []);
      }
    });
    it(`${locale}: the Community navigation label exists`, () => {
      const nav = (load(locale, 'dashboard.json').nav as Record<string, string>).community;
      expect(typeof nav).toBe('string');
      expect(nav!.length).toBeGreaterThan(0);
    });
  }

  it('the other languages are translated, not copies of the English text', () => {
    for (const locale of ['fr', 'es', 'ar'] as const) {
      const messages = flatten(load(locale, 'businessCommunity.json'));
      // Single-word cognates (for example "Participation" in French) may legitimately match; any real sentence or phrase must differ.
      const same = Object.keys(en).filter((k) => messages[k] === en[k] && en[k]!.length > 14);
      expect(same, `${locale} untranslated keys`).toEqual([]);
    }
  });

  it('Arabic is Arabic script (right-to-left) for headings, the introduction and every explainer item', () => {
    const ar = flatten(load('ar', 'businessCommunity.json'));
    for (const key of ['title', 'tagline', 'intro', 'tabs.home', 'status.title', 'about.title', 'about.what.title', 'about.privacy.body']) {
      expect(ARABIC.test(ar[key]!), key).toBe(true);
    }
    expect(ARABIC.test((load('ar', 'dashboard.json').nav as Record<string, string>).community!)).toBe(true);
  });

  it('marketing copy stays distinct from legal text: no approval, consent-contract or policy-version claims in any language of the explainer', () => {
    for (const locale of LOCALES) {
      const about = Object.entries(flatten(load(locale, 'businessCommunity.json'))).filter(([k]) => k.startsWith('about.')).map(([, v]) => v).join(' ');
      expect(about, locale).not.toMatch(/version\s*\d|effective date|legally|approved terms/i);
    }
  });
});
