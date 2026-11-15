import { rateLimitSource, resolveClient } from '../lib/client-attribution';

/** Require a verified Web Worker signature. Direct and unsigned requests fail closed. */
export function createCustomerEmailTrustedSource(config: {
  attributionSecret?: string;
  previousAttributionSecret?: string;
  sourceKeySecret: string;
  now?: () => number;
}) {
  return async (request: Request): Promise<string | null> => {
    const client = await resolveClient(
      request.headers,
      config.attributionSecret,
      config.now?.() ?? Date.now(),
      config.previousAttributionSecret,
    );
    if (!client.trusted) return null;
    const source = rateLimitSource(client.ip);
    if (source === 'unknown') return null;
    const encoder = new TextEncoder();
    const secret = encoder.encode(config.sourceKeySecret);
    if (secret.length < 32) return null;
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`customer-email/source/v1:${source}`));
    return Array.from(new Uint8Array(digest), (octet) => octet.toString(16).padStart(2, '0')).join('');
  };
}
