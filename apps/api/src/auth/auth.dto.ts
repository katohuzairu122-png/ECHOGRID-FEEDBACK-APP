import { z } from 'zod';

/**
 * Request validation for the auth endpoints. Lives here (not
 * packages/shared-types) on purpose -- shared-types is reserved for the
 * public API contract starting Block 7; until then, request shapes that
 * only the API itself consumes stay local to the feature that owns them.
 */

export const signupSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(12, { error: 'Password must be at least 12 characters.' }),
  fullName: z.string().trim().min(1).max(200),
});

export const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export type SignupBody = z.infer<typeof signupSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
