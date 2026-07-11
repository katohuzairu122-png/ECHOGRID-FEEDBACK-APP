import { z } from 'zod';

/**
 * The authenticated principal's own profile -- GET /auth/me
 * (auth/auth.routes.ts). Every authenticated user can call it; platformRole
 * is null for the overwhelming majority (ordinary staff). apps/web's
 * platform admin shell (Platform Admin Console Block 5) is this field's
 * first real consumer -- see apps/api/src/db/schema/users.ts's
 * PLATFORM_ROLES comment for why the column itself stayed API-internal
 * until now.
 *
 * platformRole's literal values are duplicated from that file's
 * PLATFORM_ROLES rather than imported -- this package must never import
 * apps/api (see this package's index.ts header), matching businessSchema's
 * status field's same duplication-with-a-CHECK-constraint tradeoff in
 * businesses.ts. Keep the two lists in sync by hand.
 */
export const currentUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  platformRole: z.enum(['support', 'billing', 'admin']).nullable(),
  // Platform Admin Console Block 7: non-null only when the caller's access
  // token is an impersonation token (auth/jwt.ts's signImpersonationToken)
  // -- the platform admin's own userId. Lets the web app's dashboard shell
  // detect "I am currently impersonating" and show the exit banner
  // (dashboard/impersonation-banner.tsx) without decoding the JWT client-
  // side, which it never has direct access to anyway (httpOnly cookie).
  impersonatedBy: z.uuid().nullable(),
});

export type CurrentUserDto = z.infer<typeof currentUserSchema>;
