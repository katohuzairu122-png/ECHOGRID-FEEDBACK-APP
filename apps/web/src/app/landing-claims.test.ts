import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Public-claims guard for the landing page and brand tagline. Public copy may describe only
 * deployed behaviour. Features that are planned or not released (discovery, a feed, social posting,
 * a marketplace, advertising, Partner Credits) must not appear in public strings until they ship and
 * the owner approves the wording. This test must be updated deliberately when that happens.
 */
const LOCALES = ['en', 'fr', 'es', 'ar'] as const;
const read = (locale: string, file: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'messages', locale, file), 'utf8'));

const FORBIDDEN = [
  /marketplace/i,
  /social[ -]?commerce/i,
  /facebook/i,
  /partner credit/i,
  /advertis/i,
  /sponsored/i,
  /\bfeed\b/i,
  /discover/i,
  /march[ée] /i,
  /anunci/i,
  /publicit/i,
  /إعلان/,
];

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe.each(LOCALES)('public positioning copy (%s)', (locale) => {
  const landing = strings(read(locale, 'landing.json').marketing);
  const tagline = read(locale, 'common.json').tagline as string;

  it('makes no claim about unreleased features', () => {
    for (const text of [...landing, tagline]) {
      for (const pattern of FORBIDDEN) expect(text, `${pattern} in: ${text}`).not.toMatch(pattern);
    }
  });

  it('no longer leads with the old feedback-only tagline', () => {
    expect(tagline).not.toMatch(/Every Voice|Chaque voix|Cada voz|كل صوت/);
  });

  it('keeps the trust statement: memberships stay separate', () => {
    const items = read(locale, 'landing.json').marketing.customer.items;
    expect(items['4'].description.length).toBeGreaterThan(40);
  });
});

describe('english positioning', () => {
  it('states the one-account headline', () => {
    const hero = read('en', 'landing.json').marketing.hero;
    expect(`${hero.title} ${hero.accent}`).toBe('One account. All your loyalties.');
    expect(read('en', 'common.json').tagline).toBe('One account. All your loyalties.');
  });
});
