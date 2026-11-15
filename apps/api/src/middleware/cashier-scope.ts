import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Bindings } from '../config/env';
import { verifyCashierAccessToken } from '../auth/jwt';
import { AppError } from '../lib/errors';
import type { AuthVariables } from './authenticate';

/**
 * CASHIER-PWA-01 C2: the deny-by-default route allow-list for cashier-scoped tokens.
 *
 * A cashier token (see auth/jwt.ts) is a normal staff identity narrowed to ONE business (and optionally ONE branch)
 * and to the counter routes below. Everything else, including every route added in the future, is refused until it
 * is listed here on purpose. Existing authorization (authenticate, resolveTenantContext, requirePermission) still
 * applies to every listed route; this list only narrows, it never grants.
 *
 * Paths are relative to /api/v1 and are matched exactly (method and path, no wildcard segments beyond a single
 * path parameter, no trailing slash). Administrative areas (billing, team, roles, settings, loyalty programme and
 * reward configuration, analytics, platform, internal) are deliberately absent.
 */
export type CashierRoute = { method: 'GET' | 'POST'; pattern: RegExp; label: string };

const PARAM = '[^/?#]+';

export const CASHIER_ALLOWED_ROUTES: readonly CashierRoute[] = [
  {
    method: 'POST',
    pattern: /^\/loyalty\/actions\/resolve-customer$/,
    label: 'POST /loyalty/actions/resolve-customer',
  },
  {
    method: 'POST',
    pattern: /^\/loyalty\/actions\/lookup-customer$/,
    label: 'POST /loyalty/actions/lookup-customer',
  },
  {
    method: 'POST',
    pattern: /^\/loyalty\/actions\/lookup-purchase$/,
    label: 'POST /loyalty/actions/lookup-purchase',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/loyalty/accounts/${PARAM}/purchase$`),
    label: 'POST /loyalty/accounts/:id/purchase',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/loyalty/redemptions/${PARAM}$`),
    label: 'GET /loyalty/redemptions/:code',
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/loyalty/redemptions/${PARAM}/confirm$`),
    label: 'POST /loyalty/redemptions/:code/confirm',
  },
  { method: 'GET', pattern: /^\/businesses\/me$/, label: 'GET /businesses/me' },
  { method: 'GET', pattern: /^\/auth\/me$/, label: 'GET /auth/me' },
];

const API_PREFIX = '/api/v1';

/** Returns the path relative to /api/v1, or null if the path is not under it. */
export function toApiPath(pathname: string): string | null {
  return pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length) : null;
}

export function isCashierRouteAllowed(method: string, apiPath: string): boolean {
  return CASHIER_ALLOWED_ROUTES.some(
    (route) => route.method === method && route.pattern.test(apiPath),
  );
}

/**
 * Reads the scope claims of a bearer token WITHOUT verifying the signature. That is safe for this one purpose: the
 * result is only ever used to apply a STRICTER rule. A token that claims a cashier scope is restricted; stripping the
 * claim would break the signature, and every route still verifies the token for real (authenticate and the other
 * verifiers). Returns undefined when the header carries no scope claim at all.
 */
export function peekScopeClaims(
  authorization: string | undefined,
): { client: unknown } | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const parts = authorization.slice('Bearer '.length).split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (ch) =>
        ch.charCodeAt(0),
      ),
    );
    const payload: unknown = JSON.parse(json);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const record = payload as Record<string, unknown>;
    if ('client' in record || 'bid' in record || 'brid' in record) return { client: record.client };
  } catch {
    // Not a decodable token: it cannot carry a scope; the route's own verification refuses it.
  }
  return undefined;
}

/**
 * Global guard, mounted on the whole /api/v1 router before any route. It sits in front of EVERY bearer-token
 * surface (staff routes, platform routes, internal routes and routes that verify tokens themselves), so a cashier
 * token is refused before any handler runs, whichever route it is aimed at. (Since SEC-CASHIER-R1 the audit recorder sits in
 * front of it, so a refusal also writes a security event: one insert, no lookup.)
 */
/**
 * Sets the audit identity (user and cashier binding) from a FULLY verified cashier token, for the audit recorder to use
 * when the request is refused. Does nothing for a token that does not verify.
 */
async function attributeVerifiedCashier(c: Context<{ Bindings: Bindings; Variables: Partial<AuthVariables> }>): Promise<void> {
  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) return;
  try {
    const verified = await verifyCashierAccessToken(header.slice('Bearer '.length), c.env.JWT_ACCESS_SECRET);
    c.set('userId', verified.sub);
    c.set('cashier', { businessId: verified.bid, branchId: verified.brid ?? null });
  } catch {
    // Not a valid cashier token: leave the event unattributed.
  }
}

export const cashierScopeGuard = createMiddleware<{
  Bindings: Bindings;
  Variables: Partial<AuthVariables>;
}>(async (c, next) => {
  const claims = peekScopeClaims(c.req.header('authorization'));
  if (claims !== undefined) {
    const apiPath = toApiPath(c.req.path);
    if (
      claims.client !== 'cashier' ||
      apiPath === null ||
      !isCashierRouteAllowed(c.req.method, apiPath)
    ) {
      // SEC-CASHIER-R1 (F2): attribute the denial to the cashier ONLY when the token verifies (signature, expiry and
      // every claim). The unverified peek above is used solely to refuse; it is never used as an identity. A forged,
      // expired or malformed token is therefore recorded as an unattributed security event, not blamed on anyone.
      await attributeVerifiedCashier(c);
      throw new AppError(
        'This token cannot be used for this request.',
        403,
        'CASHIER_ROUTE_DENIED',
      );
    }
  }
  await next();
});
