'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

async function post(
  path: string,
  businessId: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return apiFetch(path, {
    method: 'POST',
    businessId,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(headers ? { headers } : {}),
  });
}

export async function createB2bRequestAction(
  targetHandle: string,
  formData: FormData,
): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const reason = String(formData.get('reason') ?? '').trim();
  try {
    await post(
      '/b2b/partnership-requests',
      business.id,
      { targetHandle, reason },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
  } catch (error) {
    const code = error instanceof ApiError ? (error.code ?? 'failed') : 'failed';
    redirect(`/dashboard/network?error=${encodeURIComponent(code)}`);
  }
  revalidatePath('/dashboard/network');
  redirect('/dashboard/network?updated=1');
}

export async function b2bRequestAction(
  action: 'accept' | 'reject' | 'cancel',
  requestId: string,
): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  try {
    await post(`/b2b/partnership-requests/${requestId}/${action}`, business.id, {});
  } catch {
    redirect('/dashboard/network?error=action-failed');
  }
  revalidatePath('/dashboard/network');
  redirect('/dashboard/network?updated=1');
}

export async function terminateB2bPartnershipAction(partnershipId: string): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  try {
    await post(`/b2b/partnerships/${partnershipId}/terminate`, business.id);
  } catch {
    redirect('/dashboard/network?error=action-failed');
  }
  revalidatePath('/dashboard/network');
  redirect('/dashboard/network?updated=1');
}

export async function markB2bNotificationReadAction(notificationId: string): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  try {
    await post(`/b2b/notifications/${notificationId}/read`, business.id);
  } catch {
    redirect('/dashboard/network?error=action-failed');
  }
  revalidatePath('/dashboard/network');
  redirect('/dashboard/network?updated=1');
}

export async function reportB2bItemAction(
  targetBusinessId: string,
  resourceType: 'business' | 'message' | 'proposal' | 'request' | 'partnership',
  resourceId: string,
  formData: FormData,
): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  try {
    await post('/b2b/reports', business.id, {
      targetBusinessId,
      resourceType,
      resourceId,
      reasonCode: String(formData.get('reasonCode') ?? 'other'),
      details: String(formData.get('details') ?? ''),
    });
  } catch {
    redirect('/dashboard/network?error=report-failed');
  }
  revalidatePath('/dashboard/network');
  redirect('/dashboard/network?updated=1');
}

export async function sendB2bMessageAction(
  partnershipId: string,
  formData: FormData,
): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  try {
    await post(`/b2b/partnerships/${partnershipId}/messages`, business.id, {
      body: String(formData.get('body') ?? ''),
    });
  } catch {
    redirect(`/dashboard/network/${partnershipId}?error=message-failed`);
  }
  revalidatePath(`/dashboard/network/${partnershipId}`);
  redirect(`/dashboard/network/${partnershipId}?updated=1`);
}

export async function createB2bProposalAction(
  partnershipId: string,
  formData: FormData,
): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  try {
    await post(`/b2b/partnerships/${partnershipId}/proposals`, business.id, {
      title: String(formData.get('title') ?? ''),
      description: String(formData.get('description') ?? ''),
    });
  } catch {
    redirect(`/dashboard/network/${partnershipId}?error=proposal-failed`);
  }
  revalidatePath(`/dashboard/network/${partnershipId}`);
  redirect(`/dashboard/network/${partnershipId}?updated=1`);
}

export async function b2bProposalAction(
  action: 'accept' | 'decline' | 'withdraw',
  proposalId: string,
  partnershipId: string,
): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  try {
    await post(`/b2b/proposals/${proposalId}/${action}`, business.id);
  } catch {
    redirect(`/dashboard/network/${partnershipId}?error=action-failed`);
  }
  revalidatePath(`/dashboard/network/${partnershipId}`);
  redirect(`/dashboard/network/${partnershipId}?updated=1`);
}

export async function reviewB2bReportAction(
  reportId: string,
  status: 'reviewing' | 'resolved' | 'dismissed',
  formData: FormData,
): Promise<void> {
  try {
    await apiFetch(`/platform/b2b/reports/${reportId}/review`, {
      method: 'POST',
      body: JSON.stringify({ status, reason: String(formData.get('reason') ?? '') }),
    });
  } catch {
    redirect('/platform/business-network?error=review-failed');
  }
  revalidatePath('/platform/business-network');
  redirect('/platform/business-network?updated=1');
}
