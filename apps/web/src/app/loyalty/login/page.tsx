import { OtpLoginForm } from './otp-login-form';
import { safeInternalPath } from '@/lib/safe-redirect';

interface LoyaltyLoginPageProps {
  searchParams: Promise<{ next?: string; phone?: string; error?: string }>;
}

export default async function LoyaltyLoginPage({ searchParams }: LoyaltyLoginPageProps) {
  const { next, phone, error } = await searchParams;
  return (
    <OtpLoginForm
      next={safeInternalPath(next, '/loyalty/dashboard')}
      initialPhone={phone}
      verifyError={error}
    />
  );
}
