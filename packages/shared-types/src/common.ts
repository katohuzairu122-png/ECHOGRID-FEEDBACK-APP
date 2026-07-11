import { z } from 'zod';

/**
 * URL-safe identifier shared by every entity that needs one (businesses,
 * branches, and future entities) -- one definition so validation can never
 * drift between entities, or between the API and any client that validates
 * client-side before submitting.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]+$/, {
    error: 'Slug may only contain lowercase letters, numbers, and hyphens.',
  })
  .min(2)
  .max(60);
