import { OtpLoginForm } from './otp-login-form';

interface LoyaltyLoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoyaltyLoginPage({ searchParams }: LoyaltyLoginPageProps) {
  const { next } = await searchParams;
  return <OtpLoginForm next={next ?? '/loyalty/dashboard'} />;
}
