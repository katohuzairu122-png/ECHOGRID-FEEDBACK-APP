import 'server-only';
import { headers } from 'next/headers';

/**
 * SEC-CASHIER-R2 F6 / STG-SEC-02B: forwards the real client address and user agent to the API, HMAC-signed, so the API can rate-limit
 * per person instead of per web Worker. Mirrors apps/api/src/lib/client-attribution.ts (same format). Inert when
 * CLIENT_ATTRIBUTION_SECRET is not configured: no header is sent and the API behaves as before.
 */
const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function signClientAttribution(
  secret: string,
  client: { ip: string; userAgent: string },
  nowMs: number,
): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ ip: client.ip, ua: client.userAgent.slice(0, 200), ts: nowMs })));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`v1.${payload}`)));
  return `v1.${payload}.${b64url(sig)}`;
}

/** Extra headers for a cashier auth call; empty when unconfigured or the caller's address is unknown. */
export async function clientAttributionHeaders(): Promise<Record<string, string>> {
  const secret = process.env.CLIENT_ATTRIBUTION_SECRET;
  if (!secret) return {};
  const h = await headers();
  const ip = h.get('cf-connecting-ip');
  if (!ip) return {};
  return { 'x-echo-client': await signClientAttribution(secret, { ip, userAgent: h.get('user-agent') ?? '' }, Date.now()) };
}

/**
 * H2: the same signed attribution for ANY server-side call to the API (staff, customer, anonymous), so the API's global per-source
 * floor can tell people apart instead of seeing this Worker's single egress address. Never throws: outside a request scope, or without
 * an address, it returns no header and the API falls back to its legacy per-address key.
 */
export async function signedAttributionHeadersSafe(): Promise<Record<string, string>> {
  try {
    return await clientAttributionHeaders();
  } catch {
    return {};
  }
}
