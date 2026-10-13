import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SUPPORTED_LOCALES } from '@echo-grid-feedback/shared-types';
import { loadMessages } from '@/i18n/load-messages';
import { LANDING_PLANS } from './landing-plans';

function messageKeys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .flatMap(([key, child]) => messageKeys(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

describe('public landing content', () => {
  it('advertises only approved USD monthly prices, with Enterprise explicitly custom', () => {
    // Read the independently owned catalog without importing API types into the web program.
    const source = readFileSync(
      resolve(process.cwd(), '../api/src/billing/subscription-catalog.ts'),
      'utf8',
    );
    const catalog = [
      ...source.matchAll(
        /key:\s*'(\w+)'[\s\S]*?priceMonthlyCents:\s*(\d+)[\s\S]*?currency:\s*'(\w+)'[\s\S]*?isActive:\s*(true|false)/g,
      ),
    ];
    for (const plan of LANDING_PLANS) {
      const approved = catalog.find((candidate) => candidate[1] === plan.key);
      expect(approved?.[4]).toBe('true');
      expect(approved?.[3]).toBe('usd');
      if (plan.key === 'enterprise') expect(plan.monthlyCents).toBeNull();
      else expect(plan.monthlyCents).toBe(Number(approved?.[2]));
    }
  });

  it.each(SUPPORTED_LOCALES)('provides every marketing message in %s', async (locale) => {
    const english = await loadMessages('en');
    const localized = await loadMessages(locale);
    const canonical = (english.landing as { marketing: unknown }).marketing;
    const translated = (localized.landing as { marketing: unknown }).marketing;
    expect(messageKeys(translated)).toEqual(messageKeys(canonical));
    expect(JSON.stringify(translated)).not.toMatch(/""/);
  });
});
