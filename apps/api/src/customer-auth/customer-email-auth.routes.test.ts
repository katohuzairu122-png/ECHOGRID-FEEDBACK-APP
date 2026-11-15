import { describe, expect, it } from 'vitest';
import {
  customerEmailAuthRoutes,
  emailPasswordLoginSchema,
  emailRegistrationCompleteSchema,
  emailRegistrationRequestSchema,
} from './customer-email-auth.routes';

describe('CUSTOMER-AUTH-01D-4b-S2 email HTTP contract', () => {
  it('keeps every email endpoint unavailable before proof delivery and limiter certification', async () => {
    for (const path of ['/email/register/request', '/email/register/complete', '/email/login']) {
      const response = await customerEmailAuthRoutes.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone@example.com', password: 'password' }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });
    }
  });
  it('rejects unknown fields and malformed emails', () => {
    expect(emailRegistrationRequestSchema.safeParse({ email: 'bad' }).success).toBe(false);
    expect(emailRegistrationRequestSchema.safeParse({ email: 'a@example.com', phone: '+15555555555' }).success).toBe(false);
    expect(emailPasswordLoginSchema.safeParse({ email: 'a@example.com', password: 'abc', role: 'staff' }).success).toBe(false);
  });
  it('requires challenge id and proof for registration completion', () => {
    expect(emailRegistrationCompleteSchema.safeParse({ email: 'a@example.com', password: 'abc' }).success).toBe(false);
    expect(emailRegistrationCompleteSchema.safeParse({ email: 'a@example.com', challengeId: 'not-uuid', proof: '123456', password: 'abc' }).success).toBe(false);
  });
});
