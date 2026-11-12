import 'server-only';
import { cache } from 'react';
import { apiFetch } from './api-client';
import { getActiveBusinessQuiet } from './business';

export interface MyAccess {
  /** Effective permissions for the active business; empty when they could not be read. */
  permissions: ReadonlySet<string>;
  /** True only when the read succeeded, so a failure is never mistaken for "no permissions". */
  known: boolean;
}

/**
 * The caller's effective permissions for the active business, read from the existing
 * GET /businesses/me. Presentation only: the API still enforces every permission.
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

/**
 * Counter staff (cashier): can record purchases and redeem (loyalty:manage) but cannot configure the
 * programme (rewards:manage, which covers tiers and rewards). Requires a successful read, so a
 * transient failure never turns an owner into a cashier.
 */
export function isCounterStaff(access: MyAccess): boolean {
  return (
    access.known &&
    access.permissions.has('loyalty:manage') &&
    !access.permissions.has('rewards:manage')
  );
}

/** Programme configuration (tiers, rewards): owner, admin and manager roles. Fails closed when unknown. */
export function canConfigureProgramme(access: MyAccess): boolean {
  return access.known && access.permissions.has('rewards:manage');
}
