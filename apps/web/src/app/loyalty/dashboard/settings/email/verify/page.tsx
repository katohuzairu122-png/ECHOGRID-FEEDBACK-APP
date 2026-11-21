import { notFound } from 'next/navigation';
import { isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';
import { CustomerEmailUpgradeVerifyForm } from './upgrade-verify-form';

export const dynamic = 'force-dynamic';

export default function CustomerEmailUpgradeVerifyPage() {
  if (!isCustomerEmailAuthWebEnabled()) notFound();
  return <CustomerEmailUpgradeVerifyForm />;
}
