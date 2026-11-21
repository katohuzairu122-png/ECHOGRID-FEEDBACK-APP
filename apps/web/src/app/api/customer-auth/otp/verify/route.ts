import { NextRequest, NextResponse } from 'next/server';
import type { CustomerAuthResponse } from '@echo-grid-feedback/shared-types';
import { ApiError } from '@/lib/api-client';
import {
  CUSTOMER_PENDING_PHONE_COOKIE,
  CUSTOMER_TOKEN_COOKIE,
} from '@/lib/customer-cookies';
import { publicApiFetch } from '@/lib/public-api-client';
import { callCustomerAuthApi, isCustomerEmailAuthWebEnabled } from '@/lib/customer-email-auth-client';
import { readRefreshResponse } from '@/lib/customer-session-bff';
import { setRotatingCustomerSession } from '@/lib/customer-session';
import { safeInternalPath } from '@/lib/safe-redirect';

const CUSTOMER_TOKEN_MAX_AGE = 90 * 24 * 60 * 60;

function safeNext(value: unknown): string {
  return safeInternalPath(value, '/loyalty/dashboard');
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get('content-type') ?? '';
  const isFormPost =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data');

  const phone = request.cookies.get(CUSTOMER_PENDING_PHONE_COOKIE)?.value.trim() ?? '';
  let submittedPhone = '';
  let code = '';
  let next = '/loyalty/dashboard';

  try {
    if (isFormPost) {
      const formData = await request.formData();
      submittedPhone = String(formData.get('phone') ?? '').trim();
      code = String(formData.get('code') ?? '').trim();
      next = safeNext(formData.get('next'));
    } else {
      const body = (await request.json()) as { phone?: unknown; code?: unknown; next?: unknown };
      submittedPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
      code = typeof body.code === 'string' ? body.code.trim() : '';
      next = safeNext(body.next);
    }
  } catch {
    if (isFormPost) {
      return verificationErrorRedirect(request, next, phone, 'Invalid request.');
    }
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (!phone) {
    const error = 'Your verification request expired. Please request a new code.';
    if (isFormPost) return verificationErrorRedirect(request, next, '', error);
    return NextResponse.json({ error }, { status: 400 });
  }

  if (submittedPhone && submittedPhone !== phone) {
    const error = 'The verification request does not match this phone number. Please request a new code.';
    if (isFormPost) return verificationErrorRedirect(request, next, phone, error);
    return NextResponse.json({ error }, { status: 400 });
  }

  if (!code) {
    const error = 'Verification code is required.';
    if (isFormPost) return verificationErrorRedirect(request, next, phone, error);
    return NextResponse.json({ error }, { status: 400 });
  }

  // With password authentication enabled, a freshly verified legacy phone OTP
  // becomes a revocable OTP session instead of another 90-day bearer. The API
  // accepts this route only from the signed Web Worker, not from arbitrary callers.
  if (isCustomerEmailAuthWebEnabled() && process.env.CUSTOMER_LEGACY_UPGRADE_ENABLED === 'true') {
    try {
      const reply = await callCustomerAuthApi('/customer-auth/email/legacy/otp-login', {
        body: { phone, code },
      });
      if (reply.status !== 200) {
        const error = reply.status === 401 ? 'Code is invalid or has expired.' : 'Verification is unavailable. Please try again.';
        if (isFormPost) return verificationErrorRedirect(request, next, phone, error);
        return NextResponse.json({ error }, { status: reply.status === 401 ? 401 : 503 });
      }
      const credentials = readRefreshResponse(reply.body);
      if (!credentials) throw new Error('Invalid rotating-session response');
      await setRotatingCustomerSession(credentials);
      return isFormPost ? NextResponse.redirect(new URL(next, request.url), 303) : NextResponse.json({ success: true });
    } catch {
      const error = 'Verification is unavailable. Please try again.';
      if (isFormPost) return verificationErrorRedirect(request, next, phone, error);
      return NextResponse.json({ error }, { status: 503 });
    }
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
