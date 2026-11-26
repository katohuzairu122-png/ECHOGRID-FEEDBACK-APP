/**
 * Exact decimal arithmetic over STRINGS (no floating point). A decimal is "[-]digits[.digits]" with at most MAX_SCALE fractional digits; arithmetic is done on BigInt
 * scaled by 10^MAX_SCALE. Division rounds HALF UP (documented) to a caller-chosen scale. Used by the attribution foundations, where binary floating point is not acceptable.
 */
export const MAX_SCALE = 6;
const ONE = 10n ** BigInt(MAX_SCALE);
export class DecimalError extends Error {}
export function parseDecimal(s: string): bigint {
  if (typeof s !== 'string' || !/^-?\d+(\.\d{1,6})?$/.test(s)) throw new DecimalError(`Not an exact decimal with at most ${MAX_SCALE} fractional digits: ${String(s)}`);
  const neg = s.startsWith('-'); const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(i!) * ONE + BigInt(f.padEnd(MAX_SCALE, '0'));
  return neg ? -v : v;
}
export function formatDecimal(v: bigint, scale = MAX_SCALE): string {
  if (scale < 0 || scale > MAX_SCALE) throw new DecimalError('Scale out of range.');
  const neg = v < 0n; const a = neg ? -v : v; const drop = 10n ** BigInt(MAX_SCALE - scale);
  const q = (a + drop / 2n) / drop; // half-up at the requested scale
  const s = q.toString().padStart(scale + 1, '0'); const out = scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
  return neg && q !== 0n ? `-${out}` : out;
}
export const add = (a: string, b: string) => formatDecimal(parseDecimal(a) + parseDecimal(b));
export const sub = (a: string, b: string) => formatDecimal(parseDecimal(a) - parseDecimal(b));
export const sum = (xs: readonly string[]) => formatDecimal(xs.reduce((t, x) => t + parseDecimal(x), 0n));
export const isPositive = (a: string) => parseDecimal(a) > 0n;
/** a / b to `scale` fractional digits, half-up. Throws on division by zero (callers must treat a zero denominator as UNAVAILABLE first). */
export function divide(a: string, b: string, scale = 4): string {
  const d = parseDecimal(b); if (d === 0n) throw new DecimalError('Division by zero.');
  const n = parseDecimal(a); const neg = (n < 0n) !== (d < 0n); const an = n < 0n ? -n : n; const ad = d < 0n ? -d : d;
  const num = an * 10n ** BigInt(scale); const r = (num * 2n + ad) / (ad * 2n); // round half up
  const s = r.toString().padStart(scale + 1, '0'); const out = scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
  return neg && r !== 0n ? `-${out}` : out;
}
