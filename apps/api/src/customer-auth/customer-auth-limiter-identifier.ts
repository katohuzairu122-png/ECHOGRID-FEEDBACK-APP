import { customerChallengeDigest, normalizeLoginEmail } from './customer-email-challenge-digest';
import { isUuid } from './session-tokens';

/** Keep existing email budgets stable. Non-email login subjects use a
 * separate HMAC domain; challenge subject validation remains email-only. */
export async function customerAuthLimiterIdentifier(secret: string, value: string): Promise<string> {
  if (normalizeLoginEmail(value) === value) {
    return customerChallengeDigest({ secret, purpose: 'email_registration', field: 'subject', value });
  }
  const phone = /^\+[1-9][0-9]{6,14}$/.test(value);
  const passwordChange = value === 'password-change' ||
    (value.startsWith('password-change:') && isUuid(value.slice('password-change:'.length)));
  const encoder = new TextEncoder();
  if ((!phone && !passwordChange) || encoder.encode(secret).length < 32) {
    throw new Error('Invalid customer authentication limiter identifier');
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key,
    encoder.encode(`echo-grid/customer-auth-limiter/v1/\0${phone ? 'phone' : 'password-change'}/\0${value}`));
  return Array.from(new Uint8Array(mac), byte => byte.toString(16).padStart(2, '0')).join('');
}
