import { redirect } from 'next/navigation';
import { hasCashierSession } from '@/lib/cashier/session';
import { CashierLoginForm } from './cashier-login-form';

export default async function CashierLoginPage() {
  // Already signed in on this device: straight to the counter (the layout re-validates the session).
  if (await hasCashierSession()) redirect('/cashier');
  return <CashierLoginForm />;
}
