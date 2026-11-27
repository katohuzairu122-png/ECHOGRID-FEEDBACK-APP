import { eq, sql } from 'drizzle-orm';
import { currencyExponent } from '@echo-grid-feedback/shared-types';
import type { Database } from '../db/client';
import { businesses } from '../db/schema';

/**
 * LPC-14: exact decimal money for authoritative loyalty calculations. Nothing here uses binary floating point for a decision: values are parsed as
 * decimal TEXT into integers of thousandths (every supported currency has at most three decimals), compared and summed as BigInt, and formatted
 * back to text. More decimals than allowed are REFUSED, never rounded.
 */
export class MoneyTextError extends Error {
  constructor(readonly code: 'INVALID_FORMAT' | 'TOO_MANY_DECIMALS', message: string) {
    super(message);
    this.name = 'MoneyTextError';
  }
}

const DECIMAL = /^(\d{1,12})(?:\.(\d{1,3}))?$/;

/** A non-negative decimal (text, or a number whose shortest JavaScript text has no exponent) as integer thousandths, exactly. */
export function toMilli(value: string | number): bigint {
  const text = (typeof value === 'number' ? String(value) : value).trim();
  const match = DECIMAL.exec(text);
  if (!match) throw new MoneyTextError(/^\d+\.\d{4,}$/.test(text) ? 'TOO_MANY_DECIMALS' : 'INVALID_FORMAT', 'A money amount is a plain decimal with at most three decimal places.');
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0'));
}

/** Integer thousandths as decimal text with exactly `scale` decimals (0 to 3); thousandths beyond `scale` must be zero, otherwise it is refused. */
export function fromMilli(milli: bigint, scale: number): string {
  const unit = 10n ** BigInt(3 - scale);
  if (milli % unit !== 0n) throw new MoneyTextError('TOO_MANY_DECIMALS', `This amount needs more than ${scale} decimal places.`);
  const whole = milli / 1000n;
  const frac = (milli % 1000n).toString().padStart(3, '0').slice(0, scale);
  return scale === 0 ? whole.toString() : `${whole}.${frac}`;
}

/** Display only: the nearest JavaScript number of an exact amount of thousandths. Never feed the result back into a decision. */
export const milliToNumber = (milli: bigint): number => Number(milli) / 1000;

// ---- Storage scale (migration 0108 widens the money columns from two to three decimals) ----------------------------------------------------

const MONEY_COLUMNS: readonly [string, string][] = [
  ['loyalty_purchase_events', 'qualifying_amount'],
  ['loyalty_rewards', 'reward_value'],
  ['loyalty_rewards', 'max_budget'],
  ['loyalty_transactions', 'purchase_amount'],
];

let cache: { scale: number; at: number } | null = null;
const TTL_MS = 60_000;
export const resetMoneyStorageScaleCache = (): void => { cache = null; };

/**
 * The number of decimals the database can store in EVERY loyalty money column right now (the smallest scale among them). Read from the catalogue,
 * so the code is safe in either deploy order: until migration 0108 is applied this is 2 and a third decimal is refused (PostgreSQL would otherwise
 * round it silently on insert); afterwards it is 3. Cached for a minute per isolate.
 */
export async function moneyStorageScale(db: Pick<Database, 'execute'>, now: number = Date.now()): Promise<number> {
  if (cache && now - cache.at < TTL_MS) return cache.scale;
  let scale = 3;
  for (const [table, column] of MONEY_COLUMNS) {
    const result = await db.execute(sql`SELECT atttypmod FROM pg_attribute WHERE attrelid = ${`public.${table}`}::regclass AND attname = ${column}`);
    const typmod = Number((result.rows[0] as { atttypmod?: number | string } | undefined)?.atttypmod);
    // A numeric(p, s) typmod is ((p << 16) | s) + 4; an unconstrained numeric is -1 (no limit).
    const columnScale = Number.isFinite(typmod) && typmod > 0 ? (typmod - 4) & 0xffff : 3;
    scale = Math.min(scale, columnScale);
  }
  cache = { scale, at: now };
  return scale;
}

/** Decimals a business may use for loyalty money: its currency's own exponent, capped by what the database can store. */
export async function moneyScaleFor(db: Database, businessId: string): Promise<number> {
  const [business] = await db.select({ currency: businesses.defaultCurrency }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return Math.min(business ? currencyExponent(business.currency) : 2, await moneyStorageScale(db));
}
