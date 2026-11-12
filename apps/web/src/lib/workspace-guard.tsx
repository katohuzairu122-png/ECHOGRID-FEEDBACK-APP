import 'server-only';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { RestrictedPanel } from '@/components/workspace/restricted-panel';
import { canConfigureProgramme, classifyWorkspace, getMyAccess } from './permissions';

/** The cashier's only workspace and home. */
export const CASHIER_HOME = '/dashboard/loyalty/scan';

/**
 * Gate for business-management screens. Counter staff go to the cashier home (never to another
 * management page); an unconfirmed permission set shows an explicit unavailable state; everyone else
 * proceeds (the API remains the authority). Returns null to render the page, or the panel to render instead.
 * Layout and page render independently in Next, so this protects the visible UI; it is not a substitute
 * for the API checks, which this change does not relax.
 */
export async function managementGate(): Promise<ReactNode | null> {
  const kind = classifyWorkspace(await getMyAccess());
  if (kind === 'cashier') redirect(CASHIER_HOME);
  if (kind === 'unavailable') return <RestrictedPanel variant="unavailable" />;
  return null;
}

/** Gate for programme configuration (tiers, rewards): needs rewards:manage. */
export async function programmeGate(): Promise<ReactNode | null> {
  const access = await getMyAccess();
  const kind = classifyWorkspace(access);
  if (kind === 'cashier') redirect(CASHIER_HOME);
  if (kind === 'unavailable') return <RestrictedPanel variant="unavailable" />;
  if (!canConfigureProgramme(access)) return <RestrictedPanel variant="forbidden" />;
  return null;
}
