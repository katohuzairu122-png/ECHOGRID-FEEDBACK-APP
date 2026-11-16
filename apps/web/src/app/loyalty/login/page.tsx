import { OtpLoginForm } from './otp-login-form';
import { safeInternalPath } from '@/lib/safe-redirect';
import { isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';

interface LoyaltyLoginPageProps {
  searchParams: Promise<{ next?: string; phone?: string; error?: string }>;
}

export default async function LoyaltyLoginPage({ searchParams }: LoyaltyLoginPageProps) {
  const { next, phone, error } = await searchParams;
  return (
    <OtpLoginForm
      next={safeInternalPath(next, '/loyalty/dashboard')}
      emailEnabled={isCustomerEmailAuthWebEnabled()}
      initialPhone={phone}
      verifyError={error}
    />
  );
}
