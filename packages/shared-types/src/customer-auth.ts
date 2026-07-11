import { z } from 'zod';

/**
 * Customer identity contract (Digital Loyalty module). Customers never get a
 * platform login like staff (see auth.ts / users) -- identity is established
 * via SMS OTP against a phone number instead. Lives in shared-types (not
 * apps/api/src/customer-auth/*.dto.ts) because this is genuinely public API
 * surface: apps/web's customer-facing loyalty pages call these endpoints
 * directly, same reasoning as feedback.ts's submitFeedbackSchema.
 */

const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export const requestOtpSchema = z.object({
  phone: z.string().trim().regex(E164_PHONE, { error: 'Phone must be in E.164 format, e.g. +15551234567.' }),
});

export const verifyOtpSchema = z.object({
  phone: z.string().trim().regex(E164_PHONE),
  code: z.string().trim().length(6).regex(/^\d{6}$/, { error: 'Code must be 6 digits.' }),
});

export const customerSchema = z.object({
  id: z.uuid(),
  phone: z.string(),
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  birthday: z.string().nullable(),
  phoneVerifiedAt: z.string().nullable(),
  status: z.enum(['active', 'suspended']),
  createdAt: z.string(),
});

export const customerAuthResponseSchema = z.object({
  accessToken: z.string(),
  customer: customerSchema,
});

export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type CustomerDto = z.infer<typeof customerSchema>;
export type CustomerAuthResponse = z.infer<typeof customerAuthResponseSchema>;
