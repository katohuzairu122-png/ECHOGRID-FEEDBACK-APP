import 'server-only';
import { cookies } from 'next/headers';
import {
  CUSTOMER_PENDING_PHONE_COOKIE,
  CUSTOMER_TOKEN_COOKIE,
} from './customer-cookies';

// Matches apps/api's CUSTOMER_ACCESS_TOKEN_TTL_SECONDS (customer-auth/customer-jwt.ts).
const CUSTOMER_TOKEN_MAX_AGE = 90 * 24 * 60 * 60;

/**
 * The customer counterpart to lib/session.ts -- deliberately a separate
 * module, separate cookie name, and separate (simpler) shape: a single
 * long-lived token, no refresh pair, since apps/api's customer JWT is
 * non-rotating (see customer-jwt.ts's reasoning: lower stakes, no
 * privilege-escalation surface). Never import lib/session.ts's functions
 * for customer flows or vice versa -- staff and customer are different
 * trust boundaries that must never be able to read each other's cookie.
 */
export async function setCustomerSession(accessToken: string): Promise<void> {
  const store = await cookies();
  store.set(CUSTOMER_TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: CUSTOMER_TOKEN_MAX_AGE,
  });
}

export async function getCustomerToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(CUSTOMER_TOKEN_COOKIE)?.value;
}

export async function hasCustomerSession(): Promise<boolean> {
  const store = await cookies();
  return store.has(CUSTOMER_TOKEN_COOKIE);
}

export async function clearCustomerSession(): Promise<void> {
  const store = await cookies();
  store.delete(CUSTOMER_TOKEN_COOKIE);
}


const CUSTOMER_PENDING_PHONE_MAX_AGE = 10 * 60;

export async function setPendingCustomerPhone(phone: string): Promise<void> {
  const store = await cookies();
  store.set(CUSTOMER_PENDING_PHONE_COOKIE, phone, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: CUSTOMER_PENDING_PHONE_MAX_AGE,
  });
}

export async function getPendingCustomerPhone(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(CUSTOMER_PENDING_PHONE_COOKIE)?.value;
}

export async function clearPendingCustomerPhone(): Promise<void> {
  const store = await cookies();
  store.delete(CUSTOMER_PENDING_PHONE_COOKIE);
}

const ROTATING_ACCESS_COOKIE = '__Host-ff_customer_access';
const ROTATING_REFRESH_COOKIE = '__Host-ff_customer_refresh';
const rotatingCookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

export type RotatingCustomerCredentials = {
  accessToken: string;
  refreshCredential: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
};

/** Server-only transport for the dormant rotating-session BFF. */
export async function setRotatingCustomerSession(credentials: RotatingCustomerCredentials): Promise<void> {
  const store = await cookies();
  // Remove the legacy cookie at the transition so an expired pair cannot fall back to it.
  store.delete(CUSTOMER_TOKEN_COOKIE);
  store.set(ROTATING_ACCESS_COOKIE, credentials.accessToken, {
    ...rotatingCookieOptions, expires: credentials.accessExpiresAt,
  });
  store.set(ROTATING_REFRESH_COOKIE, credentials.refreshCredential, {
    ...rotatingCookieOptions, expires: credentials.refreshExpiresAt,
  });
}

export async function getCompatibleCustomerCredentials() {
  const store = await cookies();
  if (store.has(ROTATING_ACCESS_COOKIE) || store.has(ROTATING_REFRESH_COOKIE)) {
    return {
      kind: 'rotating' as const,
      accessToken: store.get(ROTATING_ACCESS_COOKIE)?.value,
      refreshCredential: store.get(ROTATING_REFRESH_COOKIE)?.value,
    };
  }
  return { kind: 'legacy' as const, accessToken: store.get(CUSTOMER_TOKEN_COOKIE)?.value };
}

/** Clear only after the session owner has completed any required server revocation. */
export async function clearCompatibleCustomerSession(): Promise<void> {
  const store = await cookies();
  for (const name of [ROTATING_ACCESS_COOKIE, ROTATING_REFRESH_COOKIE]) {
    store.set(name, '', { ...rotatingCookieOptions, maxAge: 0 });
  }
  store.delete(CUSTOMER_TOKEN_COOKIE);
}
