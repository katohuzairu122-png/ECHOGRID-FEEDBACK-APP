import { Hono } from 'hono';
import { updateCustomerLanguageSchema } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { customerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimit } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

/**
 * The calling customer's saved UI language. Only the caller's own row is ever
 * read or written (customerId comes from the verified JWT, never the request).
 */
export const customerLanguageRoutes = new Hono<Env>();
customerLanguageRoutes.use('*', customerAuthenticate, rateLimit('PUBLIC_RATE_LIMITER'));

customerLanguageRoutes.get('/', async (c) => {
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const customer = await createRepositories(db).customers.findById(c.get('customerId'));
    if (!customer) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
    return ok(c, { locale: customer.preferredLocale });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});

customerLanguageRoutes.put('/', async (c) => {
  const input = await parseJsonBody(c.req.raw, updateCustomerLanguageSchema);
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const row = await createRepositories(db).customers.setPreferredLocale(c.get('customerId'), input.locale);
    if (!row) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
    return ok(c, { locale: row.preferredLocale });
  } finally {
    c.executionCtx.waitUntil(close());
  }
});
