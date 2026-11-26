import { notFound } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api-client';
import { getCurrentUser } from '@/lib/platform';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { canViewTentaship, parseCampaigns, shufflePath } from './campaigns';
import { CampaignsView } from './campaigns-view';

/** The API answers a generic 404 unless TENTASHIP_SHUFFLE_ENABLED is exactly "true"; so does this page (it never reveals whether the feature exists). */
export default async function TentashipPage() {
  if (!canViewTentaship(await getCurrentUser())) notFound();
  let raw: unknown;
  try {
    raw = await apiFetch<unknown>(`${shufflePath}/campaigns`, { cache: 'no-store' });
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) notFound();
    raw = null;
  }
  return <CampaignsView campaigns={parseCampaigns(raw)} />;
}
