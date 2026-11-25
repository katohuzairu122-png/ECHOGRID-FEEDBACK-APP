import 'server-only';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { RestrictedPanel } from '@/components/workspace/restricted-panel';
import { canConfigureProgramme, canViewCommunityHub, classifyWorkspace, getMyAccess } from './permissions';

/** The cashier's only workspace and home. */
export const CASHIER_HOME = '/dashboard/loyalty/scan';
/** BCOMM-01: the business Community hub (the default home of owners and managers) and the Business Overview it sits beside. */
export const COMMUNITY_HOME = '/dashboard/community';
export const OVERVIEW_HOME = '/dashboard/overview';

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

/**
 * Gate for the business Community hub. Counter staff go to the cashier home; an unconfirmed permission set shows the unavailable state; a
 * management user without a hub permission sees the forbidden panel (never another privileged page). Pages and the layout each call it,
 * because they render independently in Next. The Community API enforces the same rule.
 */
export async function communityHubGate(): Promise<ReactNode | null> {
  const access = await getMyAccess();
  const kind = classifyWorkspace(access);
  if (kind === 'cashier') redirect(CASHIER_HOME);
  if (kind === 'unavailable') return <RestrictedPanel variant="unavailable" />;
  if (!canViewCommunityHub(access)) return <RestrictedPanel variant="forbidden" />;
  return null;
}
