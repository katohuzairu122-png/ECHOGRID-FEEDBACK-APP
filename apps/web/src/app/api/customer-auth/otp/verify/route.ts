import { NextResponse } from 'next/server';
import type { CustomerAuthResponse } from '@echo-grid-feedback/shared-types';
import { ApiError } from '@/lib/api-client';
import { CUSTOMER_TOKEN_COOKIE } from '@/lib/customer-cookies';
import { publicApiFetch } from '@/lib/public-api-client';

const CUSTOMER_TOKEN_MAX_AGE = 90 * 24 * 60 * 60;

export async function POST(request: Request): Promise<NextResponse> {
  let body: { phone?: unknown; code?: unknown };
  try {
    body = (await request.json()) as { phone?: unknown; code?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!phone || !code) {
    return NextResponse.json({ error: 'Phone number and verification code are required.' }, { status: 400 });
  }

  let result: CustomerAuthResponse;
  try {
    result = await publicApiFetch<CustomerAuthResponse>('/customer-auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    );
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(CUSTOMER_TOKEN_COOKIE, result.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: CUSTOMER_TOKEN_MAX_AGE,
  });
  return response;
}
