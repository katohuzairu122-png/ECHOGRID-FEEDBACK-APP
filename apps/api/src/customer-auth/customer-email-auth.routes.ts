import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { IssuedSession } from './customer-session.service';
import type { PasswordLoginResult } from './customer-password-auth.service';
import type { EmailRegistrationResult } from './customer-email-registration.service';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(1).max(1024);
export const emailRegistrationRequestSchema = z.object({ email }).strict();
export const emailRegistrationCompleteSchema = z.object({
  email, challengeId: z.uuid(), proof: z.string().min(6).max(256), password,
}).strict();
export const emailPasswordLoginSchema = z.object({ email, password }).strict();

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
  requestProof(email: string): Promise<void>;
  completeRegistration(input: z.infer<typeof emailRegistrationCompleteSchema>): Promise<EmailRegistrationResult>;
  login(input: z.infer<typeof emailPasswordLoginSchema>): Promise<PasswordLoginResult>;
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
    if (!source) return 'unavailable';
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
  } catch {
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
  routes.onError(() => unavailable());
  routes.post(paths.request, async (c) => {
    const dto = emailRegistrationRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return badRequest();
    const decision = await limitEmailAuthRequest(dependencies, c.req.raw, 'delivery', dto.data.email);
    if (decision !== 'allowed') return deny(decision);
    // Delivery errors and suppressions share the same response.
    await dependencies.requestProof(dto.data.email).catch(() => undefined);
    return accepted();
  });
  routes.post(paths.complete, async (c) => {
    const dto = emailRegistrationCompleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return badRequest();
    if (!await dependencies.resolveTrustedSource(c.req.raw)) return unavailable();
    const result = await dependencies.completeRegistration(dto.data);
    return result.ok ? c.json({ registered: true }, 201) : invalid();
  });
  routes.post(paths.login, async (c) => {
    const dto = emailPasswordLoginSchema.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return badRequest();
    const decision = await limitEmailAuthRequest(dependencies, c.req.raw, 'login', dto.data.email);
    if (decision !== 'allowed') return deny(decision);
    const result = await dependencies.login(dto.data);
    return result.ok ? dependencies.transportSession(result.session) : invalid();
  });
  return routes;
}
