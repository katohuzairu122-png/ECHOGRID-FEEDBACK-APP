import { notFound } from 'next/navigation';
import { SignupRequestForm } from './signup-request-form';
import { safeInternalPath } from '@/lib/safe-redirect';
import { isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';

export const dynamic = 'force-dynamic';

export default async function CustomerSignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!isCustomerEmailAuthWebEnabled()) notFound();
  const { next } = await searchParams;
  return <SignupRequestForm next={safeInternalPath(next, '/loyalty/dashboard')} />;
}
