import Stripe from 'stripe';

/**
 * HETA-01-F1 B.3: verify the Stripe signature over the exact raw body FIRST; parsing is a separate step
 * (shape.ts). Only a missing/invalid signature is rejected here (the only 400). Returns the provenance
 * fields stored for webhook_signature rows, because Stripe signatures cannot be re-verified later.
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
  | { ok: false; reason: 'MISSING_HEADER' | 'MALFORMED_HEADER' | 'NO_SECRET' | 'INVALID_SIGNATURE' };

interface ParsedHeader { t: number; v1: string[] }

function parseHeader(header: string): ParsedHeader | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^[0-9]{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
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
  if (opts.secrets.length === 0) return { ok: false, reason: 'NO_SECRET' };
  const now = opts.now ?? new Date();
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  // Stripe's verifier rejects stale timestamps only; a timestamp from the future is rejected here too.
  if (tolerance > 0 && parsed.t - Math.floor(now.getTime() / 1000) > tolerance) return { ok: false, reason: 'INVALID_SIGNATURE' };
  const sig = Stripe.webhooks.signature;
  if (!sig) return { ok: false, reason: 'INVALID_SIGNATURE' };
  const provider = opts.cryptoProvider ?? Stripe.createSubtleCryptoProvider();
  for (const s of opts.secrets) {
    let valid = false;
    try {
      valid = await sig.verifyHeaderAsync(opts.rawBody, opts.header, s.secret, tolerance, provider, now.getTime());
    } catch {
      valid = false;
    }
    if (valid) return { ok: true, provenance: { headerTimestamp: parsed.t, scheme: 'v1', secretLabel: s.label, verifiedAt: now, verifierVersion: VERIFIER_VERSION } };
  }
  return { ok: false, reason: 'INVALID_SIGNATURE' };
}
