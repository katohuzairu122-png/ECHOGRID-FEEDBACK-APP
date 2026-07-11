import { z } from 'zod';
import { slugSchema } from './common';
import { localeSchema } from './i18n';

/**
 * Business create request contract -- mirrors createBranchSchema's role
 * for branches (Branch Mgmt Block 1): one definition shared by apps/api's
 * request validation and apps/web's "create your first business"
 * onboarding form (Branch Mgmt Block 4).
 */
export const createBusinessSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugSchema,
});

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

/**
 * Business settings update contract (i18n & Multi-Currency Block 1) --
 * deliberately its own object rather than createBusinessSchema.partial():
 * slug is not patchable through this endpoint (a slug change is a bigger,
 * riskier operation than a settings edit and has no UI demand yet), so
 * reusing createBusinessSchema would accidentally expose it. This is the
 * only way a business can move its defaultLocale/defaultCurrency/
 * defaultTimezone away from the 'en'/'USD'/'UTC' seed defaults.
 */
export const updateBusinessSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  defaultLocale: localeSchema.optional(),
  // ISO 4217, format-checked only -- not validated against the real
  // ~180-currency list, matching this file's own countryCode-style
  // precedent in branches.ts. Unlike defaultLocale, currency only feeds
  // Intl.NumberFormat (which accepts virtually any real-world code), not UI
  // string lookup, so a closed enum would be an arbitrary limit, not a
  // reflection of what the platform actually supports.
  defaultCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { error: 'Must be a 3-letter ISO 4217 currency code.' })
    .optional(),
  // IANA timezone, length-checked only -- matches branches.ts's timezone
  // field exactly (same concept, same validation depth, no ~400-zone enum).
  defaultTimezone: z.string().trim().min(1).max(100).optional(),
});

export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;

/**
 * Response shape for a business. Hand-written, not inferred from the
 * Drizzle schema -- see branches.ts's branchSchema for why (this package
 * must never import apps/api, and the two are allowed to diverge).
 */
export const businessSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  defaultLocale: localeSchema,
  defaultCurrency: z.string(),
  defaultTimezone: z.string(),
  status: z.enum(['active', 'suspended', 'archived']),
});

export type BusinessDto = z.infer<typeof businessSchema>;

/**
 * Minimal public view -- no slug/status (still not safe to expose
 * unauthenticated), but now carries the 3 locale/currency/timezone fields
 * (i18n & Multi-Currency Block 1) so fully anonymous surfaces -- QR
 * check-in, feedback forms, a customer's loyalty dashboard -- can render
 * dates/numbers/currency and (from Block 4 onward) UI text in the
 * business's own configured locale rather than English/UTC/USD.
 */
export const businessPublicSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  defaultLocale: localeSchema,
  defaultCurrency: z.string(),
  defaultTimezone: z.string(),
});

export type BusinessPublicDto = z.infer<typeof businessPublicSchema>;
