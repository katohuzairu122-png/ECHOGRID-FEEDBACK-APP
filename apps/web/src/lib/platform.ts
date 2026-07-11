import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { CurrentUserDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from './api-client';

/**
 * Mirrors lib/business.ts's getActiveBusiness() error-handling exactly:
 * redirect to /login on a 401 (session cookie present but the access token
 * is invalid/expired and apiFetch's own refresh attempt also failed),
 * rethrow anything else. Backs the platform shell's auth guard
 * (app/platform/layout.tsx), the dashboard home's conditional "Platform
 * Admin" card, and (Block 7) the impersonation exit banner -- several
 * independent places in the tree that all need "who is this."
 *
 * Wrapped in React's cache() (Block 6) so those independent call sites --
 * concretely, app/platform/layout.tsx's auth guard AND
 * app/platform/businesses/[id]/page.tsx both needing the caller's role on
 * the same request -- share one /auth/me call instead of firing it once per
 * component. Request-scoped only; never leaks across requests/users.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUserDto | null> => {
  try {
    return await apiFetch<CurrentUserDto>('/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      redirect('/login');
    }
    throw err;
  }
});
