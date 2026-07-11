import { z } from 'zod';
import { slugSchema } from './common';

/**
 * Branch create/update request contract, shared by the API (server-side
 * validation via parseJsonBody) and the web app (client-side form
 * validation, landing in Branch Mgmt Block 5) so the two can never silently
 * drift apart -- the first schemas to live in this package (see index.ts).
 */
export const createBranchSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugSchema,
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  stateProvince: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  // ISO 3166-1 alpha-2, format-checked only -- not validated against the
  // real ~250-country list, to avoid a hardcoded dependency on a first
  // pass. Revisit if bad data becomes a real problem.
  countryCode: z.string().trim().length(2).toUpperCase().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  // Independently optional, matching the database (no paired CHECK
  // constraint) -- a branch with one but not the other is unusual but not
  // rejected here; tighten with a cross-field .refine() if it becomes a
  // real data-quality issue.
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const updateBranchSchema = createBranchSchema.partial();

export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;

/**
 * Response shape returned by the branch API. Hand-written rather than
 * inferred from the Drizzle schema (apps/api/src/db/schema) -- this package
 * must never import from apps/api, and the two are allowed to diverge (e.g.
 * if the DB later grows an internal-only column this should never expose).
 * Timestamps are ISO 8601 strings (JSON has no native date type).
 */
export const branchSchema = z.object({
  id: z.uuid(),
  businessId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  stateProvince: z.string().nullable(),
  postalCode: z.string().nullable(),
  countryCode: z.string().nullable(),
  timezone: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  status: z.enum(['active', 'inactive', 'archived']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BranchDto = z.infer<typeof branchSchema>;
