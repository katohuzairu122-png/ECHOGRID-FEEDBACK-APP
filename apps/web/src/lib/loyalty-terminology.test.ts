import { describe, expect, it } from 'vitest';
import en from '../../messages/en/loyalty.json';
import es from '../../messages/es/loyalty.json';
import fr from '../../messages/fr/loyalty.json';
import ar from '../../messages/ar/loyalty.json';

/**
 * LPC-11: the loyalty vocabulary is kept consistent. See docs/architecture/builds/LOYALTY/LPC_11_TERMINOLOGY.md for the glossary. These tests pin
 * the distinctions between concepts (earned versus redeemable versus redeemed rewards, programme versus tier versus points balance) and the
 * parity of the namespaces added for the programme work, in all four languages.
 */
type Messages = { staff: { serve: { card: Record<string, string>; earned: Record<string, string> } }; customer: { businessDashboard: Record<string, unknown> }; programmes: Record<string, unknown>; purchases: Record<string, unknown> };
const locales = { en, es, fr, ar } as unknown as Record<string, Messages>;

const flatten = (value: unknown, prefix = ''): Record<string, string> =>
  value && typeof value === 'object'
    ? Object.entries(value as Record<string, unknown>).reduce((acc, [k, v]) => ({ ...acc, ...flatten(v, prefix ? `${prefix}.${k}` : k) }), {})
    : { [prefix]: String(value) };

describe('loyalty terminology (LPC-11)', () => {
  it('keeps earned, redeemable and balance concepts distinct in every language', () => {
    for (const [locale, m] of Object.entries(locales)) {
      const earned = m.staff.serve.earned.title;
      const redeemable = m.staff.serve.card.rewardsTitle;
      const balance = m.staff.serve.card.points;
      expect(new Set([earned, redeemable, balance]).size, locale).toBe(3);
      // the customer page names the same concept the cashier card does
      expect((m.customer.businessDashboard as unknown as Record<string, string>).rewardsHeading, locale).toBe(redeemable);
    }
  });

  it('uses the glossary terms in English: redeemable rewards, earned rewards, points balance, programme and reversal', () => {
    expect(en.staff.serve.card.rewardsTitle).toBe('Redeemable rewards');
    expect(en.staff.serve.card.points).toBe('Points balance');
    expect(en.staff.serve.earned.title).toBe('Earned rewards');
    expect(en.customer.businessDashboard.programme).toBeTruthy();
    expect(JSON.stringify(en.purchases)).toMatch(/revers/i);
    const tier = (en.customer.businessDashboard as unknown as Record<string, string>).progressToNextTier;
    expect(tier).toContain('tier');
    expect(tier).not.toContain('pts');
  });

  it('never abbreviates points as "pts" and spells the business-facing earning scheme "programme" in the programme-era namespaces', () => {
    const scoped = flatten({ purchases: en.purchases, programmes: en.programmes, earned: en.staff.serve.earned, card: en.customer.businessDashboard.programme });
    for (const [key, text] of Object.entries(scoped)) {
      expect(text, key).not.toMatch(/\bpts\b/i);
      expect(text, key).not.toMatch(/\bprogram\b/i);
    }
  });

  it('has the same keys in all four languages for the namespaces added with the programme work', () => {
    const shape = (m: Messages) => Object.keys({ ...flatten(m.purchases, 'purchases'), ...flatten(m.programmes, 'programmes'), ...flatten(m.staff.serve.earned, 'earned'), ...flatten(m.customer.businessDashboard.programme, 'card') }).sort();
    const base = shape(locales.en!);
    for (const locale of ['es', 'fr', 'ar']) expect(shape(locales[locale]!), locale).toEqual(base);
  });
});
