import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { BusinessDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from './api-client';
import { ACTIVE_BUSINESS_COOKIE } from './cookies';
import { selectActiveBusiness } from './business-selection';

/** Shared by both exports below so the actual fetch is defined once. */
export const getBusinesses = cache(async (): Promise<BusinessDto[]> => {
  return apiFetch<BusinessDto[]>('/businesses');
});

/**
 * The business every dashboard page scopes its data to. There is currently
 * no way to belong to more than one business (no team-invite flow exists
 * yet -- the only path to membership is creating one, which makes you sole
 * Owner), so "the first business returned" is unambiguous in practice, not
 * a placeholder standing in for real switching. Revisit with a cookie- or
 * URL-based active-business selector once a later module (team management)
 * lets a user belong to multiple businesses. Extracted here in Branch Mgmt
 * Block 5 so branches/page.tsx doesn't duplicate dashboard/page.tsx's
 * original inline fetch-and-pick-first logic.
 */
export async function getActiveBusiness(): Promise<BusinessDto | null> {
  let businesses: BusinessDto[];
  try {
    businesses = await getBusinesses();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      redirect('/login');
    }
    throw err;
  }

  const selectedId = (await cookies()).get(ACTIVE_BUSINESS_COOKIE)?.value;
  return selectActiveBusiness(businesses, selectedId);
}

/**
 * Locale-resolution variant of getActiveBusiness() (i18n & Multi-Currency
 * Block 2) -- same lookup, but NEVER redirects and NEVER throws. Used by
 * i18n/request.ts, which runs on every request including fully
 * unauthenticated ones (the login pages, both anonymous QR landing pages);
 * a locale-resolution failure must always degrade to the app's default
 * locale, never hijack an unrelated page's response with a redirect that
 * has nothing to do with what the visitor actually requested. Auth
 * enforcement stays exactly where it already is -- each layout's own
 * hasSession()/redirect() check -- this function is presentation-only.
 */
export async function getActiveBusinessQuiet(): Promise<BusinessDto | null> {
  try {
    const businesses = await getBusinesses();
    const selectedId = (await cookies()).get(ACTIVE_BUSINESS_COOKIE)?.value;
    return selectActiveBusiness(businesses, selectedId);
  } catch {
    return null;
  }
}

