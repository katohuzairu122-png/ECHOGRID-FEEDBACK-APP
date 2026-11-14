import { keepStaffSurfacesOffCashierHost } from '@/lib/cashier/host-guard';

/** The staff sign-in is not served on the dedicated cashier origin (see lib/cashier/host-guard.ts). */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await keepStaffSurfacesOffCashierHost();
  return children;
}
