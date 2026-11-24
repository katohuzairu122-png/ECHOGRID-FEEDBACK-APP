import { notFound } from 'next/navigation';
import { CustomerRecoveryStartForm } from './recovery-form';
import { isCustomerRecoveryWebEnabled } from '@/lib/customer-email-auth-client';

export const dynamic = 'force-dynamic';

export default function CustomerRecoveryPage() {
  if (!isCustomerRecoveryWebEnabled()) notFound();
  return <CustomerRecoveryStartForm />;
}
