'use server';

import {
  callCustomerAuthApi,
  isCustomerRecoveryWebEnabled,
} from '@/lib/customer-email-auth-client';
import { getCustomerToken } from '@/lib/customer-session';

export type RecoveryStatus = 'awaiting_factors' | 'factors_verified' | 'security_hold';
export type RecoveryState = {
  error?: 'invalid' | 'unavailable' | 'password_mismatch' | 'invalid_input';
  started?: true;
  sent?: true;
  status?: RecoveryStatus;
  holdUntil?: string;
  completed?: true;
  cancelled?: true;
  attemptId?: string;
};
export type RecoveryCodesState = {
  error?: 'invalid' | 'unavailable';
  codes?: string[];
  revoked?: true;
};

const value = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function enabled(): boolean {
  return isCustomerRecoveryWebEnabled();
}

async function factorResult(path: string, body: unknown): Promise<RecoveryState> {
  if (!enabled()) return { error: 'unavailable' };
  try {
    const response = await callCustomerAuthApi(`/customer-recovery/${path}`, { body });
    if (response.status !== 200 || !response.body || typeof response.body !== 'object') {
      return {
        error: response.status === 401 || response.status === 400 ? 'invalid' : 'unavailable',
      };
    }
    const result = response.body as { status?: unknown; holdUntil?: unknown };
    if (
      !['awaiting_factors', 'factors_verified', 'security_hold'].includes(String(result.status))
    ) {
      return { error: 'unavailable' };
    }
    return {
      status: result.status as RecoveryStatus,
      ...(typeof result.holdUntil === 'string' ? { holdUntil: result.holdUntil } : {}),
    };
  } catch {
    return { error: 'unavailable' };
  }
}

export async function startCustomerRecoveryAction(
  _prev: RecoveryState,
  form: FormData,
): Promise<RecoveryState> {
  if (!enabled()) return { error: 'unavailable' };
  const email = value(form, 'email').toLowerCase();
  const phone = value(form, 'phone');
  const body =
    EMAIL.test(email) && email.length <= 254 ? { email } : PHONE.test(phone) ? { phone } : null;
  if (!body) return { error: 'invalid_input' };
  try {
    const response = await callCustomerAuthApi('/customer-recovery/initiate', { body });
    const attemptId =
      response.body && typeof response.body === 'object'
        ? (response.body as { attemptId?: unknown }).attemptId
        : null;
    if (response.status !== 202 || typeof attemptId !== 'string' || !UUID.test(attemptId))
      return { error: 'unavailable' };
    return { started: true, attemptId };
  } catch {
    return { error: 'unavailable' };
  }
}

export async function requestRecoveryEmailAction(
  _prev: RecoveryState,
  form: FormData,
): Promise<RecoveryState> {
  const attemptId = value(form, 'attemptId');
  if (!UUID.test(attemptId)) return { error: 'invalid_input' };
  if (!enabled()) return { error: 'unavailable' };
  try {
    const response = await callCustomerAuthApi('/customer-recovery/email-challenge', {
      body: { attemptId },
    });
    return response.status === 202
      ? { sent: true, attemptId }
      : { error: response.status === 401 ? 'invalid' : 'unavailable' };
  } catch {
    return { error: 'unavailable' };
  }
}

export async function verifyRecoveryEmailAction(
  _prev: RecoveryState,
  form: FormData,
): Promise<RecoveryState> {
  const [attemptId = '', challengeId = '', proof = ''] = value(form, 'proof').split('.');
  if (!UUID.test(attemptId) || !UUID.test(challengeId) || proof.length < 6 || proof.length > 256)
    return { error: 'invalid_input' };
  return factorResult('email-verify', { attemptId, challengeId, proof });
}

export async function requestRecoveryPhoneAction(
  _prev: RecoveryState,
  form: FormData,
): Promise<RecoveryState> {
  const attemptId = value(form, 'attemptId');
  if (!UUID.test(attemptId) || !enabled()) return { error: 'unavailable' };
  try {
    const response = await callCustomerAuthApi('/customer-recovery/phone-otp', {
      body: { attemptId },
    });
    return response.status === 202
      ? { sent: true, attemptId }
      : { error: response.status === 401 ? 'invalid' : 'unavailable' };
  } catch {
    return { error: 'unavailable' };
  }
}

export async function verifyRecoveryPhoneAction(
  _prev: RecoveryState,
  form: FormData,
): Promise<RecoveryState> {
  const attemptId = value(form, 'attemptId');
  const code = value(form, 'code');
  if (!UUID.test(attemptId) || !/^[0-9]{4,10}$/.test(code)) return { error: 'invalid_input' };
  return factorResult('phone-verify', { attemptId, code });
}

export async function verifyRecoveryCodeAction(
  _prev: RecoveryState,
  form: FormData,
): Promise<RecoveryState> {
  const attemptId = value(form, 'attemptId');
  const code = value(form, 'code');
  if (!UUID.test(attemptId) || code.length < 20 || code.length > 64)
    return { error: 'invalid_input' };
  return factorResult('code-verify', { attemptId, code });
}

export async function completeCustomerRecoveryAction(
  _prev: RecoveryState,
  form: FormData,
): Promise<RecoveryState> {
  const attemptId = value(form, 'attemptId');
  const password = String(form.get('password') ?? '');
  const confirmation = String(form.get('confirmation') ?? '');
  if (!UUID.test(attemptId) || !password) return { error: 'invalid_input' };
  if (password !== confirmation) return { error: 'password_mismatch' };
  if (!enabled()) return { error: 'unavailable' };
  try {
    const response = await callCustomerAuthApi('/customer-recovery/complete', {
      body: { attemptId, newPassword: password },
    });
    return response.status === 204
      ? { completed: true }
      : { error: response.status === 401 ? 'invalid' : 'unavailable' };
  } catch {
    return { error: 'unavailable' };
  }
}

export async function cancelCustomerRecoveryAction(
  _prev: RecoveryState,
  form: FormData,
): Promise<RecoveryState> {
  const credential = value(form, 'credential');
  if (!/^[0-9a-f-]{36}\.[0-9a-f]{64}$/i.test(credential) || !enabled()) return { error: 'invalid' };
  try {
    const response = await callCustomerAuthApi('/customer-recovery/cancel', {
      body: { credential },
    });
    return response.status === 204
      ? { cancelled: true }
      : { error: response.status === 401 ? 'invalid' : 'unavailable' };
  } catch {
    return { error: 'unavailable' };
  }
}

export async function issueCustomerRecoveryCodesAction(
  _prev: RecoveryCodesState,
  form: FormData,
): Promise<RecoveryCodesState> {
  const currentPassword = String(form.get('currentPassword') ?? '');
  const token = await getCustomerToken();
  if (!currentPassword || !token || !enabled()) return { error: 'unavailable' };
  try {
    const response = await callCustomerAuthApi('/customer-recovery/codes/issue', {
      bearer: token,
      body: { currentPassword },
    });
    if (response.status === 401 || response.status === 400) return { error: 'invalid' };
    if (response.status !== 200 || !response.body || typeof response.body !== 'object')
      return { error: 'unavailable' };
    const codes = (response.body as { codes?: unknown }).codes;
    return Array.isArray(codes) && codes.every((code) => typeof code === 'string')
      ? { codes: codes as string[] }
      : { error: 'unavailable' };
  } catch {
    return { error: 'unavailable' };
  }
}

export async function revokeCustomerRecoveryCodesAction(
  _prev: RecoveryCodesState,
  form: FormData,
): Promise<RecoveryCodesState> {
  const currentPassword = String(form.get('currentPassword') ?? '');
  const token = await getCustomerToken();
  if (!currentPassword || !token || !enabled()) return { error: 'unavailable' };
  try {
    const response = await callCustomerAuthApi('/customer-recovery/codes/revoke', {
      bearer: token,
      body: { currentPassword },
    });
    if (response.status === 401 || response.status === 400) return { error: 'invalid' };
    return response.status === 204 ? { revoked: true } : { error: 'unavailable' };
  } catch {
    return { error: 'unavailable' };
  }
}
