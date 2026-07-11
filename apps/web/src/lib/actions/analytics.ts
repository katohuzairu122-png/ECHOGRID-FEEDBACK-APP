'use server';

import { revalidatePath } from 'next/cache';
import type { GenerateSummaryInput } from '@echo-grid-feedback/shared-types';
import { apiFetch } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

/**
 * Fire-and-confirm, not fire-and-wait: POST /analytics/summaries/generate
 * returns 202 with the job merely queued -- SummaryService runs async in
 * the Cloudflare Queues consumer and can involve a real LLM call taking
 * several seconds, so this action's job is just to enqueue it and let the
 * caller know that happened, not to poll for completion. revalidatePath is
 * still called for consistency with every other mutating action here, even
 * though its visible effect is usually a no-op until the async job actually
 * finishes and a later page load picks up the new row.
 */
export async function generateSummaryAction(input: GenerateSummaryInput): Promise<void> {
  const business = await getActiveBusiness();
  if (!business) throw new Error('No active business.');

  await apiFetch('/analytics/summaries/generate', {
    method: 'POST',
    businessId: business.id,
    body: JSON.stringify(input),
  });

  revalidatePath('/dashboard/analytics');
}
