import Stripe from 'stripe';

/**
 * Standalone verifier selectively reviewed from candidate 86f709d. No route, capture,
 * persistence or HTTP status mapping is wired here. Verify exact raw bytes before
 * any JSON parsing. A successful signature is provenance, never tenant/tier authority.
 */
export const VERIFIER_VERSION = 'heta01-f1-sig/1';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SigningSecret {
  /** Non-secret label recorded as evidence (rotation-ready). Never the secret itself. */
  label: string;
  secret: string;
}

export interface SignatureProvenance {
  headerTimestamp: number;
  scheme: 'v1';
  secretLabel: string;
  verifiedAt: Date;
  verifierVersion: string;
}

export type SignatureResult =
  | { ok: true; provenance: SignatureProvenance }
  | {
      ok: false;
      reason: 'MISSING_HEADER' | 'MALFORMED_HEADER' | 'NO_SECRET' | 'INVALID_SIGNATURE';
    };

interface ParsedHeader {
  t: number;
  v1: string[];
}

function parseHeader(header: string): ParsedHeader | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' || k === 'v1') {
      // The installed SDK does not trim these fields. Reject ambiguity rather than
      // recording a timestamp/signature interpretation different from the SDK's.
      if (part !== `${k}=${v}`) return null;
      if (k === 't') {
        if (t !== null || !/^[0-9]{1,12}$/.test(v)) return null;
        t = Number(v);
      } else {
        if (!/^[0-9a-f]{64}$/.test(v)) return null;
        v1.push(v);
      }
    }
  }
  return t !== null && v1.length > 0 ? { t, v1 } : null;
}

export async function verifyWebhookSignature(opts: {
  rawBody: string;
  header: string | null | undefined;
  secrets: readonly SigningSecret[];
  now?: Date;
  toleranceSeconds?: number;
  cryptoProvider?: Stripe.CryptoProvider;
}): Promise<SignatureResult> {
  if (!opts.header) return { ok: false, reason: 'MISSING_HEADER' };
  const parsed = parseHeader(opts.header);
  if (!parsed) return { ok: false, reason: 'MALFORMED_HEADER' };
  if (opts.secrets.length === 0 || opts.secrets.some((s) => !s.secret || !s.label))
    return { ok: false, reason: 'NO_SECRET' };
  // Snapshot the verification instant before awaiting any cryptographic operation.
  const now = new Date((opts.now ?? new Date()).getTime());
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(tolerance) || tolerance <= 0)
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  // Stripe's verifier rejects stale timestamps only; a timestamp from the future is rejected here too.
  if (Math.abs(parsed.t - Math.floor(now.getTime() / 1000)) > tolerance)
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  const sig = Stripe.webhooks.signature;
  if (!sig) return { ok: false, reason: 'INVALID_SIGNATURE' };
  let provider: Stripe.CryptoProvider;
  try {
    provider = opts.cryptoProvider ?? Stripe.createSubtleCryptoProvider();
  } catch {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }
  for (const s of opts.secrets) {
    let valid = false;
    try {
      valid = await sig.verifyHeaderAsync(
        opts.rawBody,
        opts.header,
        s.secret,
        tolerance,
        provider,
        now.getTime(),
      );
    } catch {
      valid = false;
    }
    if (valid)
      return {
        ok: true,
        provenance: {
          headerTimestamp: parsed.t,
          scheme: 'v1',
          secretLabel: s.label,
          verifiedAt: now,
          verifierVersion: VERIFIER_VERSION,
        },
      };
  }
  return { ok: false, reason: 'INVALID_SIGNATURE' };
}
