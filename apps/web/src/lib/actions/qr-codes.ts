'use server';

import type { QrCodeDto } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

/**
 * Fetch-oriented Server Actions, not useActionState-bound mutations --
 * called imperatively from QrCodeDialog's onOpenChange/button handlers
 * (Server Actions support this; they don't have to be wired to a <form>).
 * Both still go through apiFetch (authenticated, businessId-scoped),
 * keeping the "browser never calls the Hono API directly" BFF invariant
 * intact even for this on-demand, dialog-triggered fetch. Fetching eagerly
 * for every branch when the list page loads instead would defeat Block 2's
 * lazy get-or-create design by auto-creating a code for branches nobody
 * has actually asked about yet.
 */
export async function getQrCodeAction(branchId: string): Promise<QrCodeDto> {
  const business = await getActiveBusiness();
  if (!business) throw new Error('No active business.');

  return apiFetch<QrCodeDto>(`/branches/${branchId}/qr-code`, { businessId: business.id });
}

export async function regenerateQrCodeAction(branchId: string): Promise<QrCodeDto> {
  const business = await getActiveBusiness();
  if (!business) throw new Error('No active business.');

  return apiFetch<QrCodeDto>(`/branches/${branchId}/qr-code/regenerate`, {
    method: 'POST',
    businessId: business.id,
  });
}
