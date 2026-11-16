import 'server-only';
import {
  clearCompatibleCustomerSession,
  getCompatibleCustomerCredentials,
  setRotatingCustomerSession,
} from './customer-session';
import { readRefreshResponse } from './customer-session-bff';
import { callCustomerAuthApi } from './customer-email-auth-client';

export type RefreshOutcome = 'refreshed' | 'invalid' | 'unavailable';

/**
 * Renews a rotating customer session from its refresh cookie and stores the new pair. Must run where cookies can be written
 * (a route handler or Server Action), never during a Server Component render. A refused or replayed credential clears the
 * session so the customer signs in again; a transient failure keeps it so a retry can still succeed.
 */
export async function refreshRotatingCustomerSession(): Promise<RefreshOutcome> {
  try {
    const credentials = await getCompatibleCustomerCredentials();
    if (credentials.kind !== 'rotating' || !credentials.refreshCredential) return 'invalid';
    const reply = await callCustomerAuthApi('/customer-session/refresh', { bearer: credentials.refreshCredential });
    if (reply.status === 401 || reply.status === 409) {
      await clearCompatibleCustomerSession();
      return 'invalid';
    }
    if (reply.status !== 200) return 'unavailable';
    const rotated = readRefreshResponse(reply.body);
    if (!rotated) return 'unavailable';
    await setRotatingCustomerSession(rotated);
    return 'refreshed';
  } catch {
    return 'unavailable';
  }
}

/**
 * Ends the rotating session: best-effort server revocation, then the cookies are ALWAYS cleared so the device is signed out
 * even if the API is unreachable. (Without the cookies the credentials cannot be used from this device.)
 */
export async function revokeRotatingCustomerSession(): Promise<void> {
  try {
    const credentials = await getCompatibleCustomerCredentials();
    if (credentials.kind === 'rotating') {
      let access = credentials.accessToken;
      if (!access && credentials.refreshCredential) {
        const reply = await callCustomerAuthApi('/customer-session/refresh', { bearer: credentials.refreshCredential });
        access = reply.status === 200 ? (readRefreshResponse(reply.body)?.accessToken) : undefined;
      }
      if (access) await callCustomerAuthApi('/customer-session/logout', { bearer: access });
    }
  } catch {
    // Best effort: the local sign-out below does not depend on it.
  } finally {
    await clearCompatibleCustomerSession();
  }
}
