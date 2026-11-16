import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { CustomerRecoveryService } from './customer-recovery-attempt.service';

/**
 * CUSTOMER-AUTH-S4-03: HTTP surface of account recovery (password reset only).
 *
 * DISABLED BY DEFAULT. Every route first asks `isEnabled`; unless the server-side gate is
 * explicitly on, the answer is the same generic 404 an unmounted path gives, and no
 * dependency is built, no database opened and no limiter touched. When the gate is on but
 * the configuration is incomplete, the answer is a generic 503 (fail closed).
 *
 * Properties of every route:
 *  - the source MUST come from the trusted-source resolver (a verified Web Worker signature);
 *    a missing, untrusted or malformed source is a 503 before any processing;
 *  - strict JSON bodies of at most 8 KiB; unknown keys are rejected;
 *  - no response reveals whether an account, an attempt or a factor exists: failures are one
 *    generic status per route, and endpoints that could confirm existence answer 202 either way;
 *  - nothing here accepts a phone number, an email recipient or a proof from the caller for any
 *    purpose other than looking up the account by its login email at initiation;
 *  - no session is ever issued and nothing is set in a cookie;
 *  - responses are never cached.
 */
export type CustomerRecoveryRouteDependencies = {
  service: Pick<CustomerRecoveryService,
    'initiate' | 'requestEmailChallenge' | 'verifyEmailFactor' | 'requestPhoneOtp' | 'verifyPhoneOtp'
    | 'verifyCodeFactor' | 'cancel' | 'complete'>;
  /** Resolves a VERIFIED login email to a customer id, or null. */
  findCustomerIdByLoginEmail(email: string): Promise<string | null>;
};

/** A valid id no customer has, so an unknown email takes the same path as a known one. */
const NO_CUSTOMER = '00000000-0000-4000-8000-000000000000';
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const attemptId = z.uuid();
const schemas = {
  initiate: z.object({ email }).strict(),
  attempt: z.object({ attemptId }).strict(),
  emailVerify: z.object({ attemptId, challengeId: z.uuid(), proof: z.string().min(6).max(256) }).strict(),
  phoneVerify: z.object({ attemptId, code: z.string().regex(/^[0-9]{4,10}$/) }).strict(),
  codeVerify: z.object({ attemptId, code: z.string().min(20).max(64) }).strict(),
  cancel: z.object({ credential: z.string().regex(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/i) }).strict(),
  complete: z.object({ attemptId, newPassword: z.string().min(1).max(1024) }).strict(),
};

const noStore = { 'Cache-Control': 'no-store' };
const empty = (status: number) => new Response(null, { status, headers: noStore });
const json = (status: number, body: unknown) => Response.json(body, { status, headers: noStore });
const notFound = () => json(404, { error: 'Not Found' });
const unavailable = () => json(503, { error: 'Service unavailable' });
const bad = () => json(400, { error: 'Invalid request' });
const denied = () => json(401, { error: 'Invalid or expired recovery request' });

export function createCustomerRecoveryRoutes(config: {
  /** The explicit server-side feature gate. Anything but a clear yes is a no. */
  isEnabled(c: Context): boolean;
  /** Cheap and database-free: the verified source of the request, or null. Runs before anything else is built. */
  resolveTrustedSource(c: Context): Promise<string | null>;
  /** Opens the database and builds the services. Called only after the gate, the source and the body all passed. */
  open(c: Context): Promise<{ deps: CustomerRecoveryRouteDependencies; close(): Promise<void> } | null>;
}) {
  const routes = new Hono();
  routes.use('*', async (c, next) => {
    if (!config.isEnabled(c)) return notFound();
    return next();
  });
  routes.use('*', bodyLimit({ maxSize: 8192, onError: () => json(413, { error: 'Invalid request' }) }));
  routes.onError(() => unavailable());

  /** Shared preamble: gate is already on; require a trusted source and a strict body, THEN open dependencies. */
  async function handle<T extends z.ZodTypeAny>(
    c: Context,
    schema: T,
    run: (input: z.infer<T>, deps: CustomerRecoveryRouteDependencies, source: string) => Promise<Response>,
  ): Promise<Response> {
    let opened: Awaited<ReturnType<typeof config.open>> = null;
    try {
      const source = await config.resolveTrustedSource(c);
      if (!source) return unavailable();
      const dto = schema.safeParse(await c.req.json().catch(() => null));
      if (!dto.success) return bad();
      opened = await config.open(c);
      if (!opened) return unavailable();
      return await run(dto.data, opened.deps, source);
    } catch {
      return unavailable();
    } finally {
      if (opened) await opened.close().catch(() => undefined);
    }
  }

  const status = (r: { ok: true; status: string; holdUntil?: Date } | { ok: false }) =>
    r.ok ? json(200, { status: r.status, ...(r.holdUntil ? { holdUntil: r.holdUntil.toISOString() } : {}) }) : denied();

  // Always 202 with an attempt id: a real one, or an indistinguishable decoy that no later step accepts.
  routes.post('/initiate', (c) => handle(c, schemas.initiate, async (input, deps, source) => {
    const customerId = await deps.findCustomerIdByLoginEmail(input.email).catch(() => null);
    const result = await deps.service.initiate({ customerId: customerId ?? NO_CUSTOMER, sourceKey: source });
    return json(202, { attemptId: result.ok ? result.attemptId : crypto.randomUUID() });
  }));
  routes.post('/email-challenge', (c) => handle(c, schemas.attempt, async (input, deps, source) => {
    await deps.service.requestEmailChallenge({ attemptId: input.attemptId, sourceKey: source });
    return json(202, { accepted: true });
  }));
  routes.post('/email-verify', (c) => handle(c, schemas.emailVerify, async (input, deps, source) =>
    status(await deps.service.verifyEmailFactor({ ...input, sourceKey: source }))));
  routes.post('/phone-otp', (c) => handle(c, schemas.attempt, async (input, deps, source) => {
    await deps.service.requestPhoneOtp({ attemptId: input.attemptId, sourceKey: source });
    return json(202, { accepted: true });
  }));
  routes.post('/phone-verify', (c) => handle(c, schemas.phoneVerify, async (input, deps, source) =>
    status(await deps.service.verifyPhoneOtp({ ...input, sourceKey: source }))));
  routes.post('/code-verify', (c) => handle(c, schemas.codeVerify, async (input, deps, source) =>
    status(await deps.service.verifyCodeFactor({ ...input, sourceKey: source }))));
  routes.post('/cancel', (c) => handle(c, schemas.cancel, async (input, deps, source) => {
    const [id, token] = input.credential.split('.') as [string, string];
    const result = await deps.service.cancel({ attemptId: id, token: token.toLowerCase(), sourceKey: source });
    return result.ok ? empty(204) : denied();
  }));
  routes.post('/complete', (c) => handle(c, schemas.complete, async (input, deps, source) => {
    const result = await deps.service.complete({ ...input, sourceKey: source });
    return result.ok ? empty(204) : denied();
  }));

  // Any other method or path under the prefix is the same generic 404 (the gate is on, but nothing else exists).
  routes.all('*', () => notFound());
  return routes;
}
