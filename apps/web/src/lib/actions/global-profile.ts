'use server';

import { revalidatePath } from 'next/cache';
import { updateCustomerProfileSchema } from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';

export type GlobalProfileFormState = { saved?: true; error?: 'invalid_name' | 'invalid_bio' | 'invalid' | 'unavailable' };

const text = (formData: FormData, key: string): string => String(formData.get(key) ?? '');

/** Empty field = clear it (null). The same strict rules the API applies are checked first so the customer gets a specific message. */
export async function updateGlobalProfileAction(
  _previous: GlobalProfileFormState,
  formData: FormData,
): Promise<GlobalProfileFormState> {
  const parsed = updateCustomerProfileSchema.safeParse({
    displayName: text(formData, 'displayName').trim() === '' ? null : text(formData, 'displayName'),
    bio: text(formData, 'bio').trim() === '' ? null : text(formData, 'bio'),
    avatarKey: text(formData, 'avatarKey') === '' ? null : text(formData, 'avatarKey'),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { error: field === 'displayName' ? 'invalid_name' : field === 'bio' ? 'invalid_bio' : 'invalid' };
  }
  try {
    await customerApiFetch('/customer-profile', { method: 'PUT', body: JSON.stringify(parsed.data) });
  } catch (error) {
    rethrowControlFlow(error);
    return { error: 'unavailable' };
  }
  revalidatePath('/loyalty/dashboard', 'layout');
  return { saved: true };
}
