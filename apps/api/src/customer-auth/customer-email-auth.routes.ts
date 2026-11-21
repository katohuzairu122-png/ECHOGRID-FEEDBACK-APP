import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { logEmailAuthUnavailable } from './customer-email-auth.diagnostics';
import type { IssuedSession } from './customer-session.service';
import type { PasswordLoginResult } from './customer-password-auth.service';
import type { EmailRegistrationResult } from './customer-email-registration.service';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(1).max(1024);
const customerDestination = z.string().max(2048).refine((value) =>
  value.startsWith('/loyalty/') && !value.startsWith('//') && !value.includes('\\') &&
  ![...value].some((character) => character.charCodeAt(0) < 0x20),
);
export const emailRegistrationRequestSchema = z.object({
  email, next: customerDestination.optional(),
  // Optional only for in-flight pre-migration registration challenge tests/compatibility.
  name: z.string().trim().min(1).max(120).optional(),
  password: password.optional(),
}).strict().refine((value) => (value.name === undefined) === (value.password === undefined));
export const emailRegistrationCompleteSchema = z.object({
  challengeId: z.uuid(), proof: z.string().min(6).max(256),
  // Old unsealed challenges may still supply their signup fields.
  email: email.optional(), name: z.string().trim().min(1).max(120).optional(), password: password.optional(),
  /** Optional, stored unverified; proven later through /loyalty/me/phone. */
  phone: z.string().trim().min(1).max(40).optional(),
}).strict();
export const emailPasswordLoginSchema = z.object({ email, password }).strict();
export const legacyOtpSessionSchema = z.object({
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
  code: z.string().min(4).max(10).regex(/^[0-9]+$/),
}).strict();
export const emailLinkCompleteSchema = z.object({
  email, challengeId: z.uuid(), proof: z.string().min(6).max(256), password,
}).strict();
export const emailPasswordChangeSchema = z.object({
  currentPassword: password,
  newPassword: password,
}).strict();

type Surface = 'delivery' | 'login';
export type EmailAuthLimiter = (input: {
  key: string;
  limit: number;
  windowSeconds: number;
}) => Promise<boolean>;

export type IsolatedEmailAuthDependencies = {
  resolveTrustedSource(request: Request): Promise<string | null>;
  keyForIdentifier(email: string): Promise<string>;
  limit: EmailAuthLimiter;
  requestProof(email: string, next?: string, signup?: { name: string; password: string }): Promise<void>;
  /** Signed Web Worker-only phone proof -> revocable OTP session for existing phone-only customers. */
  legacyOtpSession?: (phone: string, code: string) => Promise<IssuedSession | null>;
  completeRegistration(input: z.infer<typeof emailRegistrationCompleteSchema>): Promise<EmailRegistrationResult & { session?: IssuedSession }>;
  login(input: z.infer<typeof emailPasswordLoginSchema>): Promise<PasswordLoginResult>;
  changePassword(accessToken: string, input: z.infer<typeof emailPasswordChangeSchema>): Promise<boolean>;
  requestLink?: (accessToken: string, email: string) => Promise<boolean>;
  completeLink?: (accessToken: string, input: { email: string; challengeId: string; proof: string; password: string }) => Promise<boolean>;
  transportSession(session: IssuedSession): Response;
};

/**
 * Deliberately unmounted. Runtime routers must not import the isolated factory
 * before the separate activation review.
 */
export const customerEmailAuthRoutes = new Hono();

const paths = {
  request: '/email/register/request',
  complete: '/email/register/complete',
  login: '/email/login',
  changePassword: '/email/password/change',
  legacyOtpLogin: '/email/legacy/otp-login',
  linkRequest: '/email/link/request',
  linkComplete: '/email/link/complete',
};

for (const path of Object.values(paths)) {
  customerEmailAuthRoutes.post(path, (c) => c.json({ error: 'Not Found' }, 404));
}

export async function limitEmailAuthRequest(
  dependencies: Pick<IsolatedEmailAuthDependencies, 'resolveTrustedSource' | 'keyForIdentifier' | 'limit'>,
  request: Request,
  surface: Surface,
  address: string,
): Promise<'allowed' | 'limited' | 'unavailable'> {
  try {
    const source = await dependencies.resolveTrustedSource(request);
    if (!source) {
      logEmailAuthUnavailable('untrusted_source', { surface });
      return 'unavailable';
    }
    const identifier = await dependencies.keyForIdentifier(address);
    const windowSeconds = surface === 'delivery' ? 3600 : 900;
    const [sourceAllowed, identifierAllowed] = await Promise.all([
      dependencies.limit({
        key: `customer-email:${surface}:source:${source}`,
        limit: surface === 'delivery' ? 10 : 5,
        windowSeconds,
      }),
      dependencies.limit({
        key: `customer-email:${surface}:identifier:${identifier}`,
        limit: surface === 'delivery' ? 3 : 5,
        windowSeconds,
      }),
    ]);
    return sourceAllowed && identifierAllowed ? 'allowed' : 'limited';
  } catch (error) {
    logEmailAuthUnavailable('limiter_error', { surface, error });
    return 'unavailable';
  }
}

export function createIsolatedCustomerEmailAuthRoutes(dependencies: IsolatedEmailAuthDependencies) {
  const routes = new Hono();
  const invalid = () => Response.json({ error: 'Invalid credentials or proof' }, { status: 401 });
  const badRequest = () => Response.json({ error: 'Invalid request' }, { status: 400 });
  const unavailable = () => Response.json({ error: 'Service unavailable' }, { status: 503 });
  const accepted = () => Response.json({ accepted: true }, { status: 202 });
  const deny = (decision: 'limited' | 'unavailable') => decision === 'limited'
    ? Response.json({ error: 'Too many requests' }, { status: 429 })
    : unavailable();

  routes.use('/email/*', bodyLimit({
    maxSize: 8192,
    onError: () => Response.json({ error: 'Invalid request' }, { status: 413 }),
  }));
  routes.onError((error) => {
    logEmailAuthUnavailable('unhandled_error', { surface: 'runtime', error });
    return unavailable();
  });
  routes.post(paths.request, async (c) => {
    const dto = emailRegistrationRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return badRequest();
    const decision = await limitEmailAuthRequest(dependencies, c.req.raw, 'delivery', dto.data.email);
    if (decision !== 'allowed') return deny(decision);
    // Account credentials travel only from the Web BFF to this attribution-protected API.
    // The service hashes then AES-GCM seals them before issuing the email challenge.
    const signup = dto.data.name && dto.data.password
      ? { name: dto.data.name, password: dto.data.password } : undefined;
    // Preserve old email-only request calls for unexpired legacy links and existing tests.
    await (signup
      ? dependencies.requestProof(dto.data.email, dto.data.next, signup)
      : dto.data.next === undefined
        ? dependencies.requestProof(dto.data.email)
        : dependencies.requestProof(dto.data.email, dto.data.next)).catch(() => undefined);
    return accepted();
  });
  routes.post(paths.complete, async (c) => {
    const dto = emailRegistrationCompleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return badRequest();
    if (!await dependencies.resolveTrustedSource(c.req.raw)) {
      logEmailAuthUnavailable('untrusted_source', { surface: 'complete' });
      return unavailable();
    }
    const result = await dependencies.completeRegistration(dto.data);
    if (!result.ok) return invalid();
    if (!result.session) return c.json({ registered: true }, 201); // Pre-migration proof compatibility.
    // Transport the freshly issued session to the Web Worker only, never a browser response.
    const transported = dependencies.transportSession(result.session);
    return new Response(transported.body, { status: 201, headers: {
      'Cache-Control': 'no-store', 'Content-Type': transported.headers.get('Content-Type') ?? 'application/json',
    } });
  });
  routes.post(paths.login, async (c) => {
    const dto = emailPasswordLoginSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return badRequest();
    const decision = await limitEmailAuthRequest(dependencies, c.req.raw, 'login', dto.data.email);
    if (decision !== 'allowed') return deny(decision);
    const result = await dependencies.login(dto.data);
    return result.ok ? dependencies.transportSession(result.session) : invalid();
  });
  routes.post(paths.legacyOtpLogin, async (c) => {
    const dto = legacyOtpSessionSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return badRequest();
    const decision = await limitEmailAuthRequest(dependencies, c.req.raw, 'login', dto.data.phone);
    if (decision !== 'allowed') return deny(decision);
    if (!dependencies.legacyOtpSession) return unavailable();
    const session = await dependencies.legacyOtpSession(dto.data.phone, dto.data.code);
    return session ? dependencies.transportSession(session) : invalid();
  });
  routes.post(paths.linkRequest, async (c) => {
    const dto = emailRegistrationRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success || !dependencies.requestLink) return badRequest();
    const decision = await limitEmailAuthRequest(dependencies, c.req.raw, 'delivery', dto.data.email);
    if (decision !== 'allowed') return deny(decision);
    const bearer = c.req.header('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!bearer) return invalid();
    // The link service enforces fresh rotating OTP ownership; return a generic acceptance
    // for authenticated requests, including suppressed conflicting-email claims.
    return await dependencies.requestLink(bearer, dto.data.email) ? accepted() : invalid();
  });
  routes.post(paths.linkComplete, async (c) => {
    const dto = emailLinkCompleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success || !dependencies.completeLink) return badRequest();
    const decision = await limitEmailAuthRequest(dependencies, c.req.raw, 'login', dto.data.email);
    if (decision !== 'allowed') return deny(decision);
    const bearer = c.req.header('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!bearer) return invalid();
    const completed = await dependencies.completeLink(bearer, dto.data);
    return completed ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : invalid();
  });
  routes.post(paths.changePassword, async (c) => {
    if (!await dependencies.resolveTrustedSource(c.req.raw)) return unavailable();
    const dto = emailPasswordChangeSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return badRequest();
    const decision = await limitEmailAuthRequest(dependencies, c.req.raw, 'login', 'password-change');
    if (decision !== 'allowed') return deny(decision);
    const accessToken = c.req.header('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!accessToken || !await dependencies.changePassword(accessToken, dto.data)) return invalid();
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  });
  return routes;
}
