import type { EmailAuthLimiter } from './customer-email-auth.routes';

/** Code-management subjects are not emails. Keep them out of the email-proof
 * digest domain, and preserve the approved source/customer 5-per-15m ceilings. */
export function createRecoveryCodeManagementLimiter(secret: string, limit: EmailAuthLimiter) {
  return async ({ sourceKey, customerId }: { sourceKey: string; customerId: string }) => {
    const encoder = new TextEncoder();
    if (encoder.encode(secret).length < 32 || !sourceKey || sourceKey.length > 256 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) {
      throw new Error('Invalid recovery code-management limiter configuration');
    }
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = async (dimension: string, value: string) => {
      const mac = await crypto.subtle.sign('HMAC', key,
        encoder.encode(`echo-grid/recovery-code-management/v1/\0${dimension}/\0${value}`));
      return Array.from(new Uint8Array(mac), byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const [source, customer] = await Promise.all([digest('source', sourceKey), digest('customer', customerId)]);
    return (await Promise.all([
      limit({ key: `customer-recovery:code-management:source:${source}`, limit: 5, windowSeconds: 900 }),
      limit({ key: `customer-recovery:code-management:customer:${customer}`, limit: 5, windowSeconds: 900 }),
    ])).every(Boolean);
  };
}
