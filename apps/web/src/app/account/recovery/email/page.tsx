import { notFound } from 'next/navigation';
import { RecoveryEmailLanding } from '../recovery-form';
import { isCustomerRecoveryWebEnabled } from '@/lib/customer-email-auth-client';

export const dynamic = 'force-dynamic';

export default function CustomerRecoveryEmailPage() {
  if (!isCustomerRecoveryWebEnabled()) notFound();
  return <RecoveryEmailLanding />;
}
