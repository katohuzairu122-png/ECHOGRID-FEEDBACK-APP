/**
 * Exact decimal text as integer thousandths (every supported currency has at most three decimals). Self-contained on purpose: the overlay
 * boundaries must not depend on any other unmerged change. Refuses a fourth decimal, an exponent or a negative value instead of rounding.
 */
const DECIMAL = /^(\d{1,12})(?:\.(\d{1,3}))?$/;

export function toMilli(value: string): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error('A money amount is a plain decimal with at most three decimal places.');
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0'));
}
