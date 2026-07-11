import { Hono, type Context } from 'hono';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { CustomerAuthService } from './customer-auth.service';
import { createSmsService } from './sms.service';
import { requestOtpSchema, verifyOtpSchema } from '@echo-grid-feedback/shared-types';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { rateLimit } from '../middleware/rate-limit';

/**
 * Fully public routes -- no authenticate/resolveTenantContext, same as
 * qr.routes.ts's anonymous surface. OTP_RATE_LIMITER (3/min/IP) guards
 * both endpoints since each request either costs real SMS money (request)
 * or is a brute-force target (verify).
 */
export const customerAuthRoutes = new Hono<{ Bindings: Bindings }>();

async function withCustomerAuthService<T>(
  c: Context<{ Bindings: Bindings }>,
  fn: (service: CustomerAuthService) => Promise<T>,
): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  const repos = createRepositories(db);
  const sms = createSmsService(c.env.ENVIRONMENT, {
    accountSid: c.env.TWILIO_ACCOUNT_SID,
    authToken: c.env.TWILIO_AUTH_TOKEN,
    fromNumber: c.env.TWILIO_FROM_NUMBER,
  });
  const service = new CustomerAuthService(repos, sms, {
    CUSTOMER_JWT_SECRET: c.env.CUSTOMER_JWT_SECRET,
  });
  try {
    return await fn(service);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

customerAuthRoutes.post('/otp/request', rateLimit('OTP_RATE_LIMITER'), async (c) => {
  const body = await parseJsonBody(c.req.raw, requestOtpSchema);
  await withCustomerAuthService(c, (service) => service.requestOtp(body.phone));
  return c.body(null, 204);
});

customerAuthRoutes.post('/otp/verify', rateLimit('OTP_RATE_LIMITER'), async (c) => {
  const body = await parseJsonBody(c.req.raw, verifyOtpSchema);
  const result = await withCustomerAuthService(c, (service) =>
    service.verifyOtp(body.phone, body.code),
  );
  return ok(c, {
    accessToken: result.accessToken,
    customer: {
      id: result.customer.id,
      phone: result.customer.phone,
      fullName: result.customer.fullName,
      email: result.customer.email,
      birthday: result.customer.birthday,
      phoneVerifiedAt: result.customer.phoneVerifiedAt?.toISOString() ?? null,
      status: result.customer.status,
      createdAt: result.customer.createdAt.toISOString(),
    },
  });
});
