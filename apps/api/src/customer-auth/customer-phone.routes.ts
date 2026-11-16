import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { CustomerAuthEventRepository } from '../repositories/customer-auth-event.repository';
import type { CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { createDurableObjectPbkdf2Worker } from '../auth/pbkdf2-worker';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { normalizeE164 } from '../lib/phone';
import { CustomerAuthService } from './customer-auth.service';
import { createSmsService } from './sms.service';
import { TwilioVerifyService } from './twilio-verify.service';
import {
  CustomerPhoneAttachService,
  createLocalPhoneProof,
  createTwilioPhoneProof,
} from './customer-phone-attach.service';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

const requestSchema = z.object({ phone: z.string().min(1).max(40) }).strict();
const verifySchema = z.object({ phone: z.string().min(1).max(40), code: z.string().min(4).max(10) }).strict();

/** One budget per NUMBER (not per caller address): every request through the web Worker shares an address. */
async function phoneKey(request: Request): Promise<string> {
  const body = (await request.json().catch(() => ({}))) as { phone?: unknown };
  return `attach:${normalizeE164(body.phone) ?? 'invalid'}`;
}

async function withService<T>(c: Context<Env>, fn: (service: CustomerPhoneAttachService) => Promise<T>): Promise<T> {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const repos = createRepositories(db);
    const auth = new CustomerAuthService(
      repos,
      createSmsService(c.env.ENVIRONMENT, {
        accountSid: c.env.TWILIO_ACCOUNT_SID, authToken: c.env.TWILIO_AUTH_TOKEN, fromNumber: c.env.TWILIO_FROM_NUMBER,
      }),
      { CUSTOMER_JWT_SECRET: c.env.CUSTOMER_JWT_SECRET },
      createDurableObjectPbkdf2Worker(c.env.PASSWORD_HASHER),
    );
    // Production verifies through Twilio Verify, exactly as the phone sign-in does; every other environment uses local codes
    // delivered by the SMS service's non-production implementation. This code sends nothing by itself.
    const proof = c.env.ENVIRONMENT === 'production'
      ? createTwilioPhoneProof(new TwilioVerifyService({
          accountSid: c.env.TWILIO_ACCOUNT_SID, authToken: c.env.TWILIO_AUTH_TOKEN, serviceSid: c.env.TWILIO_VERIFY_SERVICE_SID,
        }))
      : createLocalPhoneProof(auth);
    return await fn(new CustomerPhoneAttachService({ customers: repos.customers, events: new CustomerAuthEventRepository(db), proof }));
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

/**
 * Mounted under /loyalty/me/phone, behind customerAuthenticate and the per-customer limiter (applied by the parent router).
 * The customer comes from the session, never from the request.
 */
export const customerPhoneRoutes = new Hono<Env>();

customerPhoneRoutes.get('/', (c) =>
  withService(c, async (service) => {
    c.header('Cache-Control', 'private, no-store');
    return ok(c, await service.status(c.get('customerId')));
  }),
);

customerPhoneRoutes.post('/request', rateLimit('OTP_RATE_LIMITER', phoneKey), async (c) => {
  const body = await parseJsonBody(c.req.raw, requestSchema);
  await withService(c, (service) => service.requestCode(c.get('customerId'), body.phone));
  return c.body(null, 204);
});

customerPhoneRoutes.post('/verify', rateLimit('OTP_RATE_LIMITER', phoneKey), async (c) => {
  const body = await parseJsonBody(c.req.raw, verifySchema);
  c.header('Cache-Control', 'private, no-store');
  return withService(c, async (service) => ok(c, await service.verifyCode(c.get('customerId'), body.phone, body.code)));
});
