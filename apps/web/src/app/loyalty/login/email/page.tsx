import { notFound } from 'next/navigation';
import { EmailLoginForm } from './email-login-form';
import { safeInternalPath } from '@/lib/safe-redirect';
import {
  isCustomerEmailAuthWebEnabled,
  isCustomerRecoveryWebEnabled,
} from '@/lib/customer-email-auth-client';

export const dynamic = 'force-dynamic';

export default async function CustomerEmailLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!isCustomerEmailAuthWebEnabled()) notFound();
  const { next } = await searchParams;
  return (
    <EmailLoginForm
      next={safeInternalPath(next, '/loyalty/dashboard')}
      recoveryEnabled={isCustomerRecoveryWebEnabled()}
    />
  );
}
