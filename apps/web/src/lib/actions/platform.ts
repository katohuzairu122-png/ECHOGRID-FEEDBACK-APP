'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { PlatformBusinessDto, ImpersonationResultDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { startImpersonation, stopImpersonation } from '@/lib/session';

export interface PlatformActionState {
  error?: string;
  success?: boolean;
}

/**
 * Bound with `.bind(null, businessId)` at the call site (status-form.tsx) --
 * same pattern as updateBranchAction, the standard way to pass an extra
 * argument to a Server Action used with useActionState.
 */
export async function updateBusinessStatusAction(
  businessId: string,
  _prevState: PlatformActionState,
  formData: FormData,
): Promise<PlatformActionState> {
  const status = String(formData.get('status') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  try {
    await apiFetch<PlatformBusinessDto>(`/platform/businesses/${businessId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, reason: reason || undefined }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(`/platform/businesses/${businessId}`);
  return { success: true };
}

/**
 * Bound with `.bind(null, businessId)`, same as above. Unlike every other
 * action in this app, success does NOT revalidate/return state for the
 * calling page to react to -- it redirects into an entirely different
 * session (see lib/session.ts's startImpersonation), so there is no
 * meaningful "stay on this page" outcome to render.
 */
export async function impersonateAction(
  businessId: string,
  _prevState: PlatformActionState,
  formData: FormData,
): Promise<PlatformActionState> {
  const userId = String(formData.get('userId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  let result: ImpersonationResultDto;
  try {
    result = await apiFetch<ImpersonationResultDto>(
      `/platform/businesses/${businessId}/impersonate`,
      { method: 'POST', body: JSON.stringify({ userId, reason }) },
    );
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  await startImpersonation({
    accessToken: result.accessToken,
    expiresAt: new Date(result.expiresAt),
  });
  redirect('/dashboard');
}

/** No API call -- impersonation tokens aren't individually revocable
 * server-side (stateless JWT, same as a normal access token), so "stopping"
 * is purely the BFF switching which token it sends next. See
 * lib/session.ts's stopImpersonation. */
export async function stopImpersonationAction(): Promise<void> {
  await stopImpersonation();
  redirect('/platform');
}
