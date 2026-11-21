import { OtpLoginForm } from './otp-login-form';
import { safeInternalPath } from '@/lib/safe-redirect';
import { isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';
import { EmailLoginForm } from './email/email-login-form';

interface LoyaltyLoginPageProps {
  searchParams: Promise<{ next?: string; phone?: string; error?: string; method?: string }>;
}

export default async function LoyaltyLoginPage({ searchParams }: LoyaltyLoginPageProps) {
  const { next, phone, error, method } = await searchParams;
  const safeNext = safeInternalPath(next, '/loyalty/dashboard');
  const emailEnabled = isCustomerEmailAuthWebEnabled();
  if (emailEnabled && method !== 'phone') return <EmailLoginForm next={safeNext} />;
  return (
    <OtpLoginForm
      next={safeNext}
      emailEnabled={emailEnabled}
      initialPhone={phone}
      verifyError={error}
    />
  );
}
