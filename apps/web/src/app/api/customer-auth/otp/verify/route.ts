import { NextResponse } from 'next/server';
import type { CustomerAuthResponse } from '@echo-grid-feedback/shared-types';
import { ApiError } from '@/lib/api-client';
import { CUSTOMER_TOKEN_COOKIE } from '@/lib/customer-cookies';
import { publicApiFetch } from '@/lib/public-api-client';

const CUSTOMER_TOKEN_MAX_AGE = 90 * 24 * 60 * 60;

function safeNext(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return '/loyalty/dashboard';
  }
  return value;
}

function verificationErrorRedirect(
  request: Request,
  next: string,
  phone: string,
  error: string,
): NextResponse {
  const target = new URL('/loyalty/login', request.url);
  target.searchParams.set('next', next);
  target.searchParams.set('phone', phone);
  target.searchParams.set('error', error);
  return NextResponse.redirect(target, 303);
}

export async function POST(request: Request): Promise<NextResponse> {
  const contentType = request.headers.get('content-type') ?? '';
  const isFormPost =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data');

  let phone = '';
  let code = '';
  let next = '/loyalty/dashboard';

  try {
    if (isFormPost) {
      const formData = await request.formData();
      phone = String(formData.get('phone') ?? '').trim();
      code = String(formData.get('code') ?? '').trim();
      next = safeNext(formData.get('next'));
    } else {
      const body = (await request.json()) as { phone?: unknown; code?: unknown; next?: unknown };
      phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      code = typeof body.code === 'string' ? body.code.trim() : '';
      next = safeNext(body.next);
    }
  } catch {
    if (isFormPost) {
      return verificationErrorRedirect(request, next, phone, 'Invalid request.');
    }
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (!phone || !code) {
    const error = 'Phone number and verification code are required.';
    if (isFormPost) return verificationErrorRedirect(request, next, phone, error);
    return NextResponse.json({ error }, { status: 400 });
  }

  let result: CustomerAuthResponse;
  try {
    result = await publicApiFetch<CustomerAuthResponse>('/customer-auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const error =
      err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
    if (isFormPost) return verificationErrorRedirect(request, next, phone, error);
    return NextResponse.json({ error }, { status });
  }

  const response = isFormPost
    ? NextResponse.redirect(new URL(next, request.url), 303)
    : NextResponse.json({ success: true });

  response.cookies.set(CUSTOMER_TOKEN_COOKIE, result.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: CUSTOMER_TOKEN_MAX_AGE,
  });
  return response;
}
