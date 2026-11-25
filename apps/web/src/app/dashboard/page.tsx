import { redirect } from 'next/navigation';
import { getActiveBusiness } from '@/lib/business';
import { canViewCommunityHub, getMyAccess } from '@/lib/permissions';
import { COMMUNITY_HOME, OVERVIEW_HOME, managementGate } from '@/lib/workspace-guard';
import { CreateBusinessForm } from './create-business-form';

/**
 * The stable business entry. Every existing sign-in path, bounce and link already targets /dashboard, so this is where the role-specific home is
 * decided (BCOMM-01) without touching authentication, the secure `next` handling or session restoration:
 *   - no business yet            -> mandatory onboarding stays right here (never bypassed);
 *   - counter staff (cashier)    -> Serve customers (managementGate redirects, unchanged);
 *   - permissions unconfirmed    -> the restricted "unavailable" state (unchanged);
 *   - owner / manager            -> the Community hub;
 *   - any other management user  -> the Business Overview.
 * No destination here redirects back to /dashboard except the onboarding fallbacks of the pages themselves, which render, never redirect, at /dashboard.
 */
export default async function DashboardEntryPage() {
  const business = await getActiveBusiness();
  if (!business) return <CreateBusinessForm />;
  const blocked = await managementGate();
  if (blocked) return blocked;
  redirect(canViewCommunityHub(await getMyAccess()) ? COMMUNITY_HOME : OVERVIEW_HOME);
}
