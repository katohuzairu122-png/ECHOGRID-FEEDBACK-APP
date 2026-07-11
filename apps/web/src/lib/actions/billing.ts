'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { BillingInterval, BillingSessionResultDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

export interface BillingActionState {
  error?: string;
}

/**
 * Resolves this request's own origin from standard forwarded headers, so
 * Checkout/Portal success/cancel/return URLs always point back at whichever
 * host actually served the request (localhost in dev, the real deployed
 * domain in production) -- same "the web app knows its own base URL
 * already" reasoning already established for QR code URLs, just read from
 * headers() (Server Action) instead of window.location (client component),
 * since these actions run server-side.
 */
async function resolveOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * Bound with `.bind(null, planId, interval)` at the call site (plan-card.tsx)
 * -- the standard pattern this codebase already uses for passing extra
 * arguments to a Server Action used with useActionState. Redirects the
 * whole browser to Stripe's hosted Checkout page on success; there is no
 * "stay on this page" outcome to render, same as impersonateAction's shape
 * (lib/actions/platform.ts).
 */
export async function createCheckoutSessionAction(
  planId: string,
  interval: BillingInterval,
  _prevState: BillingActionState,
  _formData: FormData,
): Promise<BillingActionState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  const origin = await resolveOrigin();

  let result: BillingSessionResultDto;
  try {
    result = await apiFetch<BillingSessionResultDto>('/billing/checkout', {
      method: 'POST',
      businessId: business.id,
      body: JSON.stringify({
        planId,
        interval,
        successUrl: `${origin}/dashboard/billing?checkout=success`,
        cancelUrl: `${origin}/dashboard/billing?checkout=canceled`,
      }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  redirect(result.url);
}

/** No bound arguments needed -- unlike checkout, opening the Portal never
 * needs to know which plan, only which business (resolved server-side from
 * the session, same as every other action here). */
export async function createPortalSessionAction(
  _prevState: BillingActionState,
  _formData: FormData,
): Promise<BillingActionState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  const origin = await resolveOrigin();

  let result: BillingSessionResultDto;
  try {
    result = await apiFetch<BillingSessionResultDto>('/billing/portal', {
      method: 'POST',
      businessId: business.id,
      body: JSON.stringify({ returnUrl: `${origin}/dashboard/billing` }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  redirect(result.url);
}
