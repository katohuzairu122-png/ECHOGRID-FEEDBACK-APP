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
  [/\b[A-Za-z0-9_-]{32,}\b/g, (m) => m], // placeholder: handled with its position below (a DNS host label is not a secret)
  [/(?<![\d.])\d{6}(?![\d.])/g, () => '[digits6]'],
];

const OPAQUE = /\b[A-Za-z0-9_-]{32,}\b/g;

/** A long lowercase hyphenated label that is followed by a domain (for example `echo-grid-feedback-cashier-staging.example.workers.dev`) is a public host name, not a secret. */
const isHostLabel = (match: string, whole: string, offset: number) =>
  /^[a-z0-9-]+$/.test(match) && match.includes('-') && /^\.[a-z0-9-]+\.[a-z]{2,}/.test(whole.slice(offset + match.length));

export function redactString(text: string): string {
  let out = text;
  for (const [pattern, replace] of RULES) {
    if (pattern.source === OPAQUE.source) {
      out = out.replace(OPAQUE, (m, offset: number, whole: string) => (isHostLabel(m, whole, offset) ? m : '[opaque]'));
    } else {
      out = out.replace(pattern, replace);
    }
  }
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
  for (const [kind, re] of probes) {
    if (kind === 'opaque') {
      const hit = [...text.matchAll(new RegExp(OPAQUE.source, 'g'))].some((m) => !isHostLabel(m[0], text, m.index ?? 0));
      if (hit) kinds.push(kind);
    } else if (re.test(text)) kinds.push(kind);
  }
  return kinds;
}
