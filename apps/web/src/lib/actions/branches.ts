'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';
import { readBranchForm } from '@/lib/branch-form';

export interface BranchFormState {
  error?: string;
  success?: boolean;
}

export async function createBranchAction(
  _prevState: BranchFormState,
  formData: FormData,
): Promise<BranchFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch('/branches', {
      method: 'POST',
      businessId: business.id,
      body: JSON.stringify(readBranchForm(formData)),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath('/dashboard/branches');
  return { success: true };
}

/**
 * Bound with `.bind(null, branchId)` at the call site (branch-form-dialog.tsx)
 * so useActionState still sees the (prevState, formData) shape it requires --
 * the standard pattern for passing an extra argument to a Server Action used
 * with that hook.
 */
export async function updateBranchAction(
  branchId: string,
  _prevState: BranchFormState,
  formData: FormData,
): Promise<BranchFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch(`/branches/${branchId}`, {
      method: 'PATCH',
      businessId: business.id,
      body: JSON.stringify(readBranchForm(formData)),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath('/dashboard/branches');
  return { success: true };
}

/**
 * Not wired through useActionState (see delete-branch-button.tsx) -- a
 * delete needs a confirm-then-fire interaction, not a form submission, so
 * it's called directly as a function inside startTransition instead.
 */
export async function deleteBranchAction(branchId: string): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) return;

  await apiFetch(`/branches/${branchId}`, {
    method: 'DELETE',
    businessId: business.id,
  });

  revalidatePath('/dashboard/branches');
}
