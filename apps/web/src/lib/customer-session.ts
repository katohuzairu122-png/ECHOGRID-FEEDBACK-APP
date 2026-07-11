import 'server-only';
import { cookies } from 'next/headers';
import { CUSTOMER_TOKEN_COOKIE } from './customer-cookies';

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
