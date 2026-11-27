/**
 * Exact-decimal money for loyalty earning (REWARD-02A / RW-D7).
 *
 * Money is held as an integer count of the currency's MINOR units (BigInt), never as a JavaScript float. The Kuwaiti dinar has three
 * fractional digits; every other currency keeps two until the Owner extends CURRENCY_EXPONENTS (the list beyond KWD is an open Owner
 * decision, REWARD-01 section 8.5). Input with more fractional digits than the currency allows is REJECTED, never silently rounded.
 */

/** Currencies that do not use two fractional digits. Extending this table is an Owner decision. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({ KWD: 3 });
export const DEFAULT_CURRENCY_EXPONENT = 2;
/** The largest single amount accepted, in whole currency units (unchanged from the existing API limit). */
export const MAX_MONEY_MAJOR_UNITS = 1_000_000n;
/** Rates (points per currency unit) may carry at most this many fractional digits. */
export const MAX_RATE_SCALE = 4;

export class MoneyError extends Error {
  constructor(
    readonly code:
      | 'INVALID_FORMAT'
      | 'TOO_MANY_DECIMALS'
      | 'NOT_POSITIVE'
      | 'TOO_LARGE'
      | 'INVALID_CURRENCY'
      | 'INVALID_RATE',
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

const CURRENCY_CODE = /^[A-Z]{3}$/;
const DECIMAL = /^(\d{1,15})(?:\.(\d{1,15}))?$/;

export function currencyExponent(currency: string): number {
  if (!CURRENCY_CODE.test(currency)) throw new MoneyError('INVALID_CURRENCY', 'Currency must be a three-letter ISO 4217 code.');
  return CURRENCY_EXPONENTS[currency] ?? DEFAULT_CURRENCY_EXPONENT;
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** A JavaScript number is converted through its shortest decimal string; exponent notation and non-finite values are refused. */
function toDecimalString(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError('INVALID_FORMAT', 'Amount must be a finite number.');
    const text = String(value);
    if (/e/i.test(text)) throw new MoneyError('INVALID_FORMAT', 'Amount must not use exponent notation.');
    return text;
  }
  return value.trim();
}

/** Parses a positive amount into minor units. Rejects zero, negatives, junk, extra precision and amounts above the maximum. */
export function parseMoney(value: string | number, currency: string): bigint {
  const exponent = currencyExponent(currency);
  const text = toDecimalString(value);
  if (text.startsWith('-')) throw new MoneyError('NOT_POSITIVE', 'Amount must be greater than zero.');
  const match = DECIMAL.exec(text);
  if (!match) throw new MoneyError('INVALID_FORMAT', 'Amount must be a plain decimal number.');
  const whole = match[1] as string;
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) {
    throw new MoneyError('TOO_MANY_DECIMALS', `${currency} amounts have at most ${exponent} decimal places.`);
  }
  const minor = BigInt(whole) * pow10(exponent) + (fraction ? BigInt(fraction.padEnd(exponent, '0')) : 0n);
  if (minor <= 0n) throw new MoneyError('NOT_POSITIVE', 'Amount must be greater than zero.');
  if (minor > MAX_MONEY_MAJOR_UNITS * pow10(exponent)) throw new MoneyError('TOO_LARGE', 'Amount is above the maximum allowed.');
  return minor;
}

/** Formats minor units to the currency's own number of digits: USD "9.10", KWD "9.100". Never shows a third digit for a 2-digit currency. */
export function formatMoney(minor: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const unit = pow10(exponent);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Reads a stored database numeric (for example "9.100") back into minor units. A stored value with more digits than the currency allows is a data error. */
export function minorFromStored(value: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new MoneyError('INVALID_FORMAT', 'Stored amount is not a decimal number.');
  const fraction = match[3] ?? '';
  const extra = fraction.slice(exponent);
  if (/[^0]/.test(extra)) throw new MoneyError('TOO_MANY_DECIMALS', 'Stored amount has more precision than the currency allows.');
  const minor = BigInt(match[2] as string) * pow10(exponent) + (fraction ? BigInt(fraction.slice(0, exponent).padEnd(exponent, '0')) : 0n);
  return match[1] === '-' ? -minor : minor;
}

/** A rate such as points per currency unit, held exactly as an integer numerator over 10^scale. */
export interface Rate {
  readonly numerator: bigint;
  readonly scale: number;
}

export function parseRate(value: string | number): Rate {
  const text = toDecimalString(value);
  const match = /^(\d{1,9})(?:\.(\d{1,9}))?$/.exec(text);
  if (!match) throw new MoneyError('INVALID_RATE', 'Rate must be a plain non-negative decimal number.');
  const fraction = match[2] ?? '';
  if (fraction.length > MAX_RATE_SCALE) throw new MoneyError('INVALID_RATE', `Rate has at most ${MAX_RATE_SCALE} decimal places.`);
  const scale = fraction.length;
  return { numerator: BigInt(match[1] as string) * pow10(scale) + (fraction ? BigInt(fraction) : 0n), scale };
}

/**
 * points = floor(amount x rate), exactly: floor(minor x numerator / (10^exponent x 10^scale)). The remainder is discarded, as the
 * existing engine does. The one-point differences the old float expression could show in rare artifact cases are NOT reproduced:
 * exact arithmetic governs (REWARD-01 section 8.3.3).
 */
export function pointsFor(amountMinor: bigint, currency: string, rate: Rate): number {
  if (amountMinor < 0n) throw new MoneyError('NOT_POSITIVE', 'Amount must not be negative.');
  const points = (amountMinor * rate.numerator) / (pow10(currencyExponent(currency)) * pow10(rate.scale));
  if (points > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError('TOO_LARGE', 'Points result is too large.');
  return Number(points);
}

/** Percentage of an amount in minor units, rounded DOWN (the customer is never given more than the stated percentage). */
export function percentOf(amountMinor: bigint, percentBasisPoints: number): bigint {
  if (!Number.isInteger(percentBasisPoints) || percentBasisPoints < 0 || percentBasisPoints > 10_000) {
    throw new MoneyError('INVALID_RATE', 'Percentage must be 0 to 100 in steps of 0.01.');
  }
  return (amountMinor * BigInt(percentBasisPoints)) / 10_000n;
}
