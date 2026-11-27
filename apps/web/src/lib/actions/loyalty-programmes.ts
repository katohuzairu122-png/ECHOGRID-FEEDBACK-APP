'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isProgramAvailable, validateProgramConfig, type LoyaltyProgramType } from '@echo-grid-feedback/shared-types';
import { ApiError } from '@/lib/api-error';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { buildProgrammeConfig, earningPreview, type FieldIssue, type ProgrammeDto } from '@/lib/loyalty-programmes';

export interface ProgrammeFormState {
  /** A stable code the screen translates; never raw server text. */
  errorCode?: 'NO_BUSINESS' | 'UNAVAILABLE' | 'INVALID' | 'OWNER_REQUIRED' | 'NOT_ALLOWED' | 'FAILED' | 'CONFIRM_REQUIRED';
  issues?: FieldIssue[];
  saved?: 'draft' | 'activated' | 'paused' | 'retired';
  programmeId?: string;
  preview?: ReturnType<typeof earningPreview>;
}

const PATH = '/dashboard/loyalty/programme';

function codeFor(error: unknown): ProgrammeFormState {
  if (error instanceof ApiError) {
    if (error.code === 'PROGRAM_OWNER_REQUIRED') return { errorCode: 'OWNER_REQUIRED' };
    if (error.code === 'PROGRAM_UNAVAILABLE') return { errorCode: 'UNAVAILABLE' };
    if (error.code === 'PROGRAM_CONFIG_INVALID') return { errorCode: 'INVALID', issues: [{ path: 'config', code: 'server' }] };
    if (error.status === 403 || error.status === 409) return { errorCode: 'NOT_ALLOWED' };
  }
  return { errorCode: 'FAILED' };
}

/**
 * One server action for the programme screens. `intent` selects the step; the configuration is built from the programme's OWN form, checked
 * with the shared rules (the same code the API runs) for field-level messages, and then sent to the API, which validates again and is the only
 * authority. Activation, pausing and retiring need the explicit confirmation field and are Owner-only on the API.
 */
export async function programmeAction(_prev: ProgrammeFormState, formData: FormData): Promise<ProgrammeFormState> {
  const business = await getActiveBusiness();
  if (!business) return { errorCode: 'NO_BUSINESS' };
  const intent = String(formData.get('intent') ?? '');
  const type = String(formData.get('type') ?? '') as LoyaltyProgramType;
  const programmeId = String(formData.get('programmeId') ?? '');

  try {
    if (intent === 'pause' || intent === 'retire' || intent === 'activate-existing') {
      if (formData.get('confirm') !== 'yes') return { errorCode: 'CONFIRM_REQUIRED' };
      const action = intent === 'pause' ? 'deactivate' : intent === 'retire' ? 'retire' : 'activate';
      await apiFetch(`/loyalty/programmes/${programmeId}/${action}`, { method: 'POST', businessId: business.id, body: JSON.stringify({ confirm: true }) });
      revalidatePath(PATH);
      return { saved: intent === 'pause' ? 'paused' : intent === 'retire' ? 'retired' : 'activated', programmeId };
    }

    if (!isProgramAvailable(type)) return { errorCode: 'UNAVAILABLE' };
    const config = buildProgrammeConfig(type, formData);
    const checked = validateProgramConfig(type, config, { currency: business.defaultCurrency });
    if (!checked.ok) return { errorCode: 'INVALID', issues: checked.errors.map((e) => ({ path: e.path, code: e.code })) };
    if (intent === 'preview') return { preview: earningPreview(type, checked.config, business.defaultCurrency) };

    let id = programmeId;
    if (id) await apiFetch<ProgrammeDto>(`/loyalty/programmes/${id}/config`, { method: 'PUT', businessId: business.id, body: JSON.stringify({ config }) });
    else id = (await apiFetch<ProgrammeDto>('/loyalty/programmes', { method: 'POST', businessId: business.id, body: JSON.stringify({ type, config }) })).id;

    if (intent === 'activate') {
      if (formData.get('confirm') !== 'yes') return { errorCode: 'CONFIRM_REQUIRED', programmeId: id };
      await apiFetch(`/loyalty/programmes/${id}/validate`, { method: 'POST', businessId: business.id, body: JSON.stringify({}) }).catch((error) => {
        // A programme that is already validated (an edit of an active programme) simply proceeds.
        if (!(error instanceof ApiError && error.status === 409)) throw error;
      });
      await apiFetch(`/loyalty/programmes/${id}/activate`, { method: 'POST', businessId: business.id, body: JSON.stringify({ confirm: true }) });
      revalidatePath(PATH);
      if (formData.get('setup') === 'yes') redirect('/dashboard');
      return { saved: 'activated', programmeId: id };
    }
    revalidatePath(PATH);
    return { saved: 'draft', programmeId: id };
  } catch (error) {
    if (error instanceof Error && error.message === 'NEXT_REDIRECT') throw error;
    if (typeof error === 'object' && error !== null && 'digest' in error) throw error; // Next's redirect signal
    return codeFor(error);
  }
}
