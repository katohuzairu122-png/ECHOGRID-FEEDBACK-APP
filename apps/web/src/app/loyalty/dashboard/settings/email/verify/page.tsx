import { notFound } from 'next/navigation';
import { isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';
import { CustomerEmailUpgradeVerifyForm } from './upgrade-verify-form';

export const dynamic = 'force-dynamic';

export default function CustomerEmailUpgradeVerifyPage() {
  if (!isCustomerEmailAuthWebEnabled() || process.env.CUSTOMER_LEGACY_UPGRADE_ENABLED !== 'true') notFound();
  return <CustomerEmailUpgradeVerifyForm />;
}
