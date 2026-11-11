'use server';

import { cookies } from 'next/headers';
import { localeSchema } from '@echo-grid-feedback/shared-types';
import { API_BASE_URL } from '@/lib/api-client';
import { getCustomerToken } from '@/lib/customer-session';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/locale-cookie';

export interface LanguageActionResult {
  ok: boolean;
}

/**
 * Shared LanguageSelector action. Always sets the locale cookie (works for
 * anonymous visitors). For a signed-in customer it also persists the choice
 * to their account, best effort: if that call fails (e.g. API not yet
 * upgraded) the cookie still applies and the page still switches.
 */
export async function setLanguageAction(candidate: string): Promise<LanguageActionResult> {
  const parsed = localeSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false };

  (await cookies()).set(LOCALE_COOKIE, parsed.data, {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
  });

  const token = await getCustomerToken();
  if (token) {
    try {
      await fetch(`${API_BASE_URL}/api/v1/customer-language`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: parsed.data }),
      });
    } catch {
      // Cookie already applied; persistence is retried on the next change.
    }
  }
  return { ok: true };
}
