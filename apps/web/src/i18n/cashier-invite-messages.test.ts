import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** CASHIER-AUTH-02D: the invitation text exists, with identical keys and placeholders, in every supported language (cashier screen and customer page). */
const locales = ['en', 'fr', 'es', 'ar'] as const;
const json = (locale: string, file: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/${file}.json`), 'utf8'));
const cashier = (locale: string) => json(locale, 'cashier').invite as Record<string, string>;
const nav = (locale: string) => json(locale, 'cashier').header.invite as string;
const customer = (locale: string) => json(locale, 'loyalty').customer.invite as Record<string, string>;
const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe.each([
  ['cashier.invite', cashier],
  ['loyalty.customer.invite', customer],
] as const)('%s messages', (name, read) => {
  const en = read('en');
  it.each(locales)('%s has exactly the English keys, all non-empty', (locale) => {
    const messages = read(locale);
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(messages)) expect(value.trim().length, `${name}.${locale}.${key}`).toBeGreaterThan(0);
  });
  it.each(locales)('%s keeps exactly the English placeholders in every message', (locale) => {
    const messages = read(locale);
    for (const [key, value] of Object.entries(messages)) expect(placeholders(value), `${name}.${locale}.${key}`).toEqual(placeholders(en[key]!));
  });
  it('the translations are genuinely translated, not copies of English', () => {
    for (const locale of ['fr', 'es', 'ar'] as const) {
      const messages = read(locale);
      const same = Object.keys(en).filter((k) => messages[k] === en[k]);
      expect(same, `${name}.${locale}`).toEqual([]);
    }
  });
});

describe('the Invite tab label', () => {
  it.each(locales)('%s has a non-empty label', (locale) => expect(nav(locale).trim().length).toBeGreaterThan(0));
  it('is translated', () => { for (const l of ['fr', 'es', 'ar'] as const) expect(nav(l)).not.toBe(nav('en')); });
});

describe('the customer text never claims more than the flow does', () => {
  it('the cashier-side English copy tells the cashier they never see the customer\'s details', () => {
    expect(cashier('en').intro).toMatch(/never enter or see/i);
  });
});
