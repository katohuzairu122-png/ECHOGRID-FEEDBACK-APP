import { notFound } from 'next/navigation';
import { RecoveryCancellationForm } from '../recovery-form';
import { isCustomerRecoveryWebEnabled } from '@/lib/customer-email-auth-client';

export const dynamic = 'force-dynamic';

export default function CustomerRecoveryCancelPage() {
  if (!isCustomerRecoveryWebEnabled()) notFound();
  return <RecoveryCancellationForm />;
}
