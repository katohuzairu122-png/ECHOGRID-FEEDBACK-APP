/**
 * SEC-CASHIER-R2 F6: trustworthy client attribution for requests that reach this API Worker from the web Worker.
 *
 * The web app calls this API Worker to Worker, so `cf-connecting-ip` and `user-agent` describe the web Worker, not the
 * person at the counter. The web Worker therefore forwards the real client IP and user agent in `x-echo-client`,
 * signed (HMAC-SHA256) with a secret that only the two Workers hold, and stamped with a time. This API trusts the
 * header ONLY when its signature verifies and it is fresh. An unsigned, wrongly signed, tampered or stale header is
 * ignored, so a direct caller of the API cannot choose its own address. Without the secret configured on this Worker,
 * the header is never trusted, and the cashier auth throttles keep their previous per-IP behaviour.
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
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,2})$/;
const IPV6 = /^[0-9a-f:]{2,45}$/i;
export const isPlausibleIp = (value: string) => value.length <= 45 && (IPV4.test(value) || (value.includes(':') && IPV6.test(value)));

/**
 * The rate-limit key for an address (review H1). An IPv6 client controls at least the low 64 bits of its address, so keying on
 * the full text would hand one host unlimited "sources". IPv6 is therefore keyed by its /64 prefix in canonical lower-case form
 * (`2001:DB8::1` and `2001:db8:0:0::1` are one key); IPv4 is keyed as is. Anything that is not a plausible address maps to one
 * shared bucket rather than to a caller-chosen string.
 */
export function rateLimitSource(ip: string | undefined | null): string {
  if (!ip || !isPlausibleIp(ip)) return 'unknown';
  if (!ip.includes(':')) return ip;
  const halves = ip.split('::');
  if (halves.length > 2) return 'unknown';
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return 'unknown';
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return 'unknown';
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

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

/**
 * `previousSecret` supports rotation (STG-SEC-02B): while both are set, a header signed with EITHER verifies, so the secret can
 * be changed on the API first (new value as current, old value as previous) without invalidating requests the web Worker still
 * signs with the old value. A previous secret is honoured ONLY while a current secret is configured: with no current secret
 * the feature is off and nothing is trusted, whatever else is set.
 */
export async function resolveClient(
  headers: { get(name: string): string | null },
  secret: string | undefined,
  nowMs: number = Date.now(),
  previousSecret?: string | undefined,
): Promise<ResolvedClient> {
  const header = headers.get(CLIENT_ATTRIBUTION_HEADER);
  let signed = await verifyClientAttribution(secret, header, nowMs);
  if (!signed && secret && previousSecret && previousSecret !== secret) {
    signed = await verifyClientAttribution(previousSecret, header, nowMs);
  }
  if (signed) return { ip: signed.ip, userAgent: signed.userAgent, trusted: true };
  return { ip: headers.get('cf-connecting-ip') ?? undefined, userAgent: headers.get('user-agent') ?? undefined, trusted: false };
}
