import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { customerLanguageSchema, localeSchema, type Locale } from '@echo-grid-feedback/shared-types';
import { API_BASE_URL, parseEnvelope } from './api-client';
import { getCustomerToken } from './customer-session';
import { LOCALE_COOKIE } from './locale-cookie';

/**
 * The customer's saved language, or null. Quiet by design: any failure
 * (no session, expired token, 404/5xx, endpoint not deployed yet, network)
 * degrades to null so a language lookup can never break or redirect a page.
 */
async function fetchSavedLocale(): Promise<Locale | null> {
  const token = await getCustomerToken();
  if (!token) return null;
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/customer-language`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const data = customerLanguageSchema.safeParse(await parseEnvelope<unknown>(response));
    return data.success ? data.data.locale : null;
  } catch {
    return null;
  }
}

async function readCookieLocale(): Promise<Locale | null> {
  const parsed = localeSchema.safeParse((await cookies()).get(LOCALE_COOKIE)?.value);
  return parsed.success ? parsed.data : null;
}

/**
 * Language override for customer + public surfaces. Precedence:
 * saved customer preference > locale cookie. The caller then falls back to
 * the business default and finally DEFAULT_LOCALE. Memoized per request
 * (request.ts and the nested layouts all ask).
 */
export const getLocaleOverride = cache(async (): Promise<Locale | null> => {
  return (await fetchSavedLocale()) ?? (await readCookieLocale());
});
