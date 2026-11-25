'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

/**
 * BCOMM-03 server actions for My Posts. Each is a thin caller of the API, which re-checks the permission, the tenant and the publishing
 * control on every request; nothing here decides anything. The result is a stable message key (never raw server text), so the page can show
 * it in the business's language.
 */
export interface PostFormState {
  ok?: boolean;
  /** One of the keys under `businessCommunity.posts.errors`. */
  error?: 'closed' | 'forbidden' | 'invalid' | 'conflict' | 'cap' | 'profile' | 'failed';
  handle?: string;
}

const LOCALES = ['en', 'fr', 'es', 'ar'];

function errorKey(error: unknown): NonNullable<PostFormState['error']> {
  if (!(error instanceof ApiError)) return 'failed';
  if (error.code === 'NETWORK_PROFILE_REQUIRED' || error.code === 'NETWORK_PROFILE_NOT_PUBLISHED') return 'profile';
  if (error.code === 'NETWORK_DAILY_CAP' || error.status === 429) return 'cap';
  if (error.status === 404) return 'closed';
  if (error.status === 403) return 'forbidden';
  if (error.status === 409) return 'conflict';
  if (error.status === 422 || error.status === 400) return 'invalid';
  return 'failed';
}

export async function savePostAction(_prev: PostFormState, formData: FormData): Promise<PostFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'failed' };
  const handle = String(formData.get('handle') ?? '');
  const locale = String(formData.get('contentLocale') ?? 'en');
  const link = String(formData.get('linkUrl') ?? '').trim();
  const body = {
    body: String(formData.get('body') ?? ''),
    linkUrl: link === '' ? null : link,
    contentLocale: LOCALES.includes(locale) ? locale : 'en',
  };
  try {
    const saved = await apiFetch<{ handle: string }>(handle ? `/network/business-posts/${handle}/draft` : '/network/business-posts', {
      method: handle ? 'PUT' : 'POST', businessId: business.id, body: JSON.stringify(body),
    });
    revalidatePath('/dashboard/community/posts');
    return { ok: true, handle: saved.handle };
  } catch (error) {
    return { error: errorKey(error) };
  }
}

async function simple(action: 'submit' | 'archive', formData: FormData): Promise<PostFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'failed' };
  const handle = String(formData.get('handle') ?? '');
  try {
    await apiFetch(`/network/business-posts/${handle}/${action}`, { method: 'POST', businessId: business.id });
    revalidatePath('/dashboard/community/posts');
    return { ok: true, handle };
  } catch (error) {
    return { error: errorKey(error) };
  }
}

export async function submitPostAction(_prev: PostFormState, formData: FormData): Promise<PostFormState> {
  return simple('submit', formData);
}

export async function archivePostAction(_prev: PostFormState, formData: FormData): Promise<PostFormState> {
  return simple('archive', formData);
}
