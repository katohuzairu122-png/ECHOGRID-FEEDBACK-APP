/**
 * SEC-CASHIER-R2 F6: trustworthy client attribution for requests that reach this API Worker from the web Worker.
 *
 * The web app calls this API Worker to Worker, so `cf-connecting-ip` and `user-agent` describe the web Worker, not the
 * person at the counter. The web Worker therefore forwards the real client IP and user agent in `x-echo-client`,
 * signed (HMAC-SHA256) with a secret that only the two Workers hold, and stamped with a time. This API trusts the
 * header ONLY when its signature verifies and it is fresh. An unsigned, wrongly signed, tampered or stale header is
 * ignored, so a direct caller of the API cannot choose its own address. Without the secret configured on this Worker,
 * the header is never trusted (the feature is inert and behaviour is unchanged).
 *
 * Format: `v1.<base64url(JSON {ip, ua, ts})>.<base64url(HMAC-SHA256(secret, "v1." + payload))>`
 */
export const CLIENT_ATTRIBUTION_HEADER = 'x-echo-client';
const MAX_AGE_MS = 60_000;
const MAX_FUTURE_MS = 5_000;
const MAX_UA = 200;

export interface ClientAttribution {
  ip: string;
  userAgent: string;
}

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Plausible IPv4 or IPv6 text; rejects anything that could carry delimiters or markup into a rate-limit key. */
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]{2,45}$/i;
export const isPlausibleIp = (value: string) => value.length <= 45 && (IPV4.test(value) || (value.includes(':') && IPV6.test(value)));

export async function signClientAttribution(secret: string, client: ClientAttribution, nowMs: number): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify({ ip: client.ip, ua: client.userAgent.slice(0, MAX_UA), ts: nowMs })));
  return `v1.${payload}.${b64url(await hmac(secret, `v1.${payload}`))}`;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** The attributed client when the header is genuine and fresh; null in every other case (never throws). */
export async function verifyClientAttribution(
  secret: string | undefined,
  header: string | null | undefined,
  nowMs: number,
): Promise<ClientAttribution | null> {
  if (!secret || !header) return null;
  try {
    const [version, payload, signature, extra] = header.split('.');
    if (version !== 'v1' || !payload || !signature || extra !== undefined) return null;
    if (!constantTimeEqual(await hmac(secret, `v1.${payload}`), fromB64url(signature))) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { ip?: unknown; ua?: unknown; ts?: unknown };
    if (typeof parsed.ip !== 'string' || typeof parsed.ua !== 'string' || typeof parsed.ts !== 'number') return null;
    if (nowMs - parsed.ts > MAX_AGE_MS || parsed.ts - nowMs > MAX_FUTURE_MS) return null;
    if (!isPlausibleIp(parsed.ip)) return null;
    return { ip: parsed.ip, userAgent: parsed.ua.slice(0, MAX_UA) };
  } catch {
    return null;
  }
}

export interface ResolvedClient {
  /** The signed (trusted) client address, or Cloudflare's connecting address when no valid attribution was sent. */
  ip: string | undefined;
  userAgent: string | undefined;
  /** True only when the address came from a verified attribution header: it identifies the person, not the web Worker. */
  trusted: boolean;
}

export async function resolveClient(
  headers: { get(name: string): string | null },
  secret: string | undefined,
  nowMs: number = Date.now(),
): Promise<ResolvedClient> {
  const signed = await verifyClientAttribution(secret, headers.get(CLIENT_ATTRIBUTION_HEADER), nowMs);
  if (signed) return { ip: signed.ip, userAgent: signed.userAgent, trusted: true };
  return { ip: headers.get('cf-connecting-ip') ?? undefined, userAgent: headers.get('user-agent') ?? undefined, trusted: false };
}
