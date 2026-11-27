import { Hono } from 'hono';
import { updateCustomerProfileSchema, CUSTOMER_AVATAR_KEYS, type CustomerAvatarKey, type CustomerProfileDto } from '@echo-grid-feedback/shared-types';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { customerAuthenticate as defaultCustomerAuthenticate, type CustomerAuthVariables } from '../middleware/customer-authenticate';
import { rateLimitByCustomer } from '../middleware/rate-limit';
import { parseJsonBody } from '../lib/validate';
import { ok } from '../lib/response';
import { AppError } from '../lib/errors';
import { maskLogin } from '../lib/mask-login';

type Env = { Bindings: Bindings; Variables: CustomerAuthVariables };

type CustomerRow = {
  displayName: string | null;
  bio: string | null;
  avatarKey: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
};

const known = new Set<string>(CUSTOMER_AVATAR_KEYS);

/** Only the caller's own data, and never a raw phone or e-mail: the login is returned masked. */
export function toCustomerProfileDto(row: CustomerRow): CustomerProfileDto {
  return {
    displayName: row.displayName,
    bio: row.bio,
    avatarKey: row.avatarKey && known.has(row.avatarKey) ? (row.avatarKey as CustomerAvatarKey) : null,
    fullName: row.fullName,
    maskedLogin: maskLogin({ email: row.email, phone: row.phone }),
  };
}

/**
 * PROF-01: the signed-in customer's own global profile (display name, bio, avatar from the built-in catalogue). The customer
 * id comes from the verified session, never from the request. Private to the customer: nothing here is shown to other
 * customers; a business only ever sees display name + avatar of its own members through a separate, narrower read.
 */
export function createCustomerProfileRoutes(
  customerAuthenticate = defaultCustomerAuthenticate,
  openDatabase = createDb,
) {
  const routes = new Hono<Env>();
  routes.use('*', customerAuthenticate, rateLimitByCustomer());

  routes.get('/', async (c) => {
    const { db, close } = await openDatabase(c.env.HYPERDRIVE);
    try {
      const customer = await createRepositories(db).customers.findById(c.get('customerId'));
      if (!customer) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
      return ok(c, toCustomerProfileDto(customer));
    } finally {
      c.executionCtx.waitUntil(close());
    }
  });

  routes.put('/', async (c) => {
    const input = await parseJsonBody(c.req.raw, updateCustomerProfileSchema);
    const { db, close } = await openDatabase(c.env.HYPERDRIVE);
    try {
      const row = await createRepositories(db).customers.setGlobalProfile(c.get('customerId'), input);
      if (!row) throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
      return ok(c, toCustomerProfileDto(row));
    } finally {
      c.executionCtx.waitUntil(close());
    }
  });
  return routes;
}

export const customerProfileRoutes = createCustomerProfileRoutes();
