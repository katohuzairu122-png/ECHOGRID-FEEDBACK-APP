import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../config/env';

/**
 * CUSTOMER-AUTH-01D-4b-S2: email-first HTTP contract, intentionally unmounted.
 *
 * No handler may issue credentials, mutate identities or send email until
 * verified-email proof delivery, atomic claim+credential creation and
 * identifier/source throttling are independently certified. Returning 404
 * instead of invoking legacy phone-password services prevents pre-hijacking.
 */
export const customerEmailAuthRoutes = new Hono<{ Bindings: Bindings }>();

export const emailRegistrationRequestSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
}).strict();

export const emailRegistrationCompleteSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  challengeId: z.uuid(),
  proof: z.string().min(6).max(256),
  password: z.string().min(1).max(1024),
}).strict();

export const emailPasswordLoginSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(1024),
}).strict();

/** Deliberate fail-closed contract until the S2 domain and delivery dependencies exist. */
const notAvailable = (c: Context<{ Bindings: Bindings }>) =>
  c.json({ error: 'Not Found' }, 404);

customerEmailAuthRoutes.post('/email/register/request', notAvailable);
customerEmailAuthRoutes.post('/email/register/complete', notAvailable);
customerEmailAuthRoutes.post('/email/login', notAvailable);
