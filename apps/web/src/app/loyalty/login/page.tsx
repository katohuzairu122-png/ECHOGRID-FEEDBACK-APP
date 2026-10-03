import { OtpLoginForm } from './otp-login-form';

interface LoyaltyLoginPageProps {
  searchParams: Promise<{ next?: string; phone?: string; error?: string }>;
}

export default async function LoyaltyLoginPage({ searchParams }: LoyaltyLoginPageProps) {
  const { next, phone, error } = await searchParams;
  return (
    <OtpLoginForm
      next={next ?? '/loyalty/dashboard'}
      initialPhone={phone}
      verifyError={error}
    />
  );
}
