import { createHash } from 'node:crypto';

/**
 * CASHIER-AUTH-02E E1: nothing sensitive reaches a log line, a result file or an error message.
 * Free text is redacted by pattern; objects are redacted by key name first. Identifiers (UUIDs, emails) are replaced by a short
 * stable hash, so two lines about the same record can still be correlated without exposing the record.
 */
const short = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|otp|ticket|proof|credential|api[-_]?key|session|refresh|jwt|invite(url|link)?|qr|signature|^code$|verification/i;

const RULES: ReadonlyArray<readonly [RegExp, (match: string) => string]> = [
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, () => '[jwt]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, () => 'Bearer [redacted]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => `[email:${short(m.toLowerCase())}]`],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `[id:${short(m.toLowerCase())}]`],
  [/\+\d[\d\s().-]{7,}\d/g, () => '[phone]'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, () => '[opaque]'],
  [/(?<![\d.])\d{6}(?![\d.])/g, () => '[digits6]'],
];

export function redactString(text: string): string {
  let out = text;
  for (const [pattern, replace] of RULES) out = out.replace(pattern, replace);
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The last line of defence before anything is written to disk: reports the KINDS of sensitive material still present
 * (never the material). A non-empty answer means the writer must refuse.
 */
export function findSecretLeaks(text: string): string[] {
  const kinds: string[] = [];
  const probes: ReadonlyArray<readonly [string, RegExp]> = [
    ['jwt', /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./],
    ['bearer', /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/i],
    ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
    ['uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
    ['phone', /\+\d[\d\s().-]{7,}\d/],
    ['opaque', /\b[A-Za-z0-9_-]{32,}\b/],
    ['otp', /(?<![\d.])\d{6}(?![\d.])/],
  ];
  for (const [kind, re] of probes) if (re.test(text)) kinds.push(kind);
  return kinds;
}
