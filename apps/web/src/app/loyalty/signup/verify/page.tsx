import { notFound } from 'next/navigation';
import { SignupVerifyForm } from './signup-verify-form';
import { safeInternalPath } from '@/lib/safe-redirect';
import { isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';

export const dynamic = 'force-dynamic';

// The proof lives only in the URL fragment, which the server never receives; the client component reads it.
export default async function CustomerSignupVerifyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!isCustomerEmailAuthWebEnabled()) notFound();
  const { next } = await searchParams;
  return <SignupVerifyForm next={safeInternalPath(next, '/loyalty/dashboard')} />;
}
