import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from './password-reset';

/**
 * Request validation for the auth endpoints. Lives here (not
 * packages/shared-types) on purpose -- shared-types is reserved for the
 * public API contract starting Block 7; until then, request shapes that
 * only the API itself consumes stay local to the feature that owns them.
 */

/** One definition of "an acceptable new password", shared by signup, reset
 * and change -- see MIN_PASSWORD_LENGTH's comment in password-reset.ts for
 * why these three must not be allowed to drift apart. */
const newPasswordSchema = z.string().min(MIN_PASSWORD_LENGTH, {
  error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
});

export const signupSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: newPasswordSchema,
  fullName: z.string().trim().min(1).max(200),
});

export const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const requestPasswordResetSchema = z.object({
  email: z.email().trim().toLowerCase(),
});

export const resetPasswordSchema = z.object({
  // Length-bounded but not format-checked against the 64-char hex tokens
  // generateResetToken() produces: a malformed token must fail the same way
  // an unknown one does (INVALID_RESET_TOKEN from the service), not with a
  // distinguishable 422 that tells an attacker their guess was the wrong
  // *shape*. The cap is there only to reject absurd payloads cheaply.
  token: z.string().min(1).max(512),
  newPassword: newPasswordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: newPasswordSchema,
});

export type SignupBody = z.infer<typeof signupSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
export type RequestPasswordResetBody = z.infer<typeof requestPasswordResetSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
