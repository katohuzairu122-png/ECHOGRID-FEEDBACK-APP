import 'server-only';
import { cache } from 'react';
import { apiFetch } from './api-client';
import { getActiveBusinessQuiet } from './business';
import { classifyWorkspace, type MyAccess } from './workspace-access';

export type { MyAccess, WorkspaceKind } from './workspace-access';
export {
  canConfigureProgramme,
  classifyWorkspace,
  isCounterStaff,
  MANAGEMENT_PERMISSIONS,
} from './workspace-access';

/**
 * The caller's effective permissions for the active business, read from the existing
 * GET /businesses/me. Presentation only: the API still enforces every permission. A failed read is
 * reported as unknown, never as an empty or an elevated set.
 */
export const getMyAccess = cache(async (): Promise<MyAccess> => {
  try {
    const business = await getActiveBusinessQuiet();
    if (!business) return { permissions: new Set(), known: false };
    const me = await apiFetch<{ permissions: string[] }>('/businesses/me', {
      businessId: business.id,
    });
    return { permissions: new Set(me.permissions), known: true };
  } catch {
    return { permissions: new Set(), known: false };
  }
});

export async function getWorkspaceKind() {
  return classifyWorkspace(await getMyAccess());
}
