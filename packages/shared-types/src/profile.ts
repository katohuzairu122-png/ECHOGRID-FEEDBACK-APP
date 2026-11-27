import { z } from 'zod';

/**
 * PROF-01: global customer profile and business appearance (no uploads in this block).
 *
 * Owner rulings (2026-11-27): avatars come from a closed built-in catalogue (no file storage exists or is added);
 * a customer profile is PRIVATE to the customer, except that a business may see the display name and avatar of its own
 * members; a business appearance is a logo preset plus a brand colour, shown inside the platform. Real photo and logo
 * upload is a later block and needs its own storage, moderation and (for businesses) an amendment of the BDPN no-media
 * ruling. The keys below are stable identifiers: the web app owns how each key is drawn.
 */
export const CUSTOMER_AVATAR_KEYS = [
  'sun', 'moon', 'star', 'leaf', 'wave', 'flame', 'bolt', 'heart', 'cloud', 'peak', 'bloom', 'orbit',
] as const;
export const BUSINESS_LOGO_KEYS = [
  'storefront', 'cup', 'fork', 'bag', 'scissors', 'dumbbell', 'book', 'wrench', 'leaf', 'heart', 'star', 'bolt',
] as const;
export const BUSINESS_BRAND_COLOR_KEYS = ['teal', 'blue', 'green', 'amber', 'red', 'purple', 'pink', 'slate'] as const;

export type CustomerAvatarKey = (typeof CUSTOMER_AVATAR_KEYS)[number];
export type BusinessLogoKey = (typeof BUSINESS_LOGO_KEYS)[number];
export type BusinessBrandColorKey = (typeof BUSINESS_BRAND_COLOR_KEYS)[number];

export const DISPLAY_NAME_MAX = 60;
export const BIO_MAX = 280;

/** Letters, marks, digits, spaces and . ' - _ only: no links, no e-mail addresses, no symbols. Must contain a letter. */
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{M}\p{N} .'\-_]+$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u2028\\u2029]');

export const displayNameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1)
      .max(DISPLAY_NAME_MAX)
      .regex(DISPLAY_NAME_PATTERN, 'Use letters, numbers, spaces and . \' - _ only.')
      .refine((v) => /\p{L}/u.test(v), 'Include at least one letter.')
      .refine((v) => !/\.\p{L}{2,}(?:\s|$)/u.test(v) && !/(?:^|\s)www\b/i.test(v), 'A web address is not a name.'),
  );

/** A short free-text bio: single block, line breaks allowed, no other control characters. */
export const bioSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .max(BIO_MAX)
      .refine((v) => !CONTROL_CHARS.test(v), 'The bio contains characters that are not allowed.'),
  );

/** PUT body: only the fields sent change; null clears a field. At least one field is required. */
export const updateCustomerProfileSchema = z
  .object({
    displayName: displayNameSchema.nullable().optional(),
    bio: bioSchema.nullable().optional(),
    avatarKey: z.enum(CUSTOMER_AVATAR_KEYS).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field.');

export const updateBusinessAppearanceSchema = z
  .object({
    logoKey: z.enum(BUSINESS_LOGO_KEYS).nullable().optional(),
    brandColorKey: z.enum(BUSINESS_BRAND_COLOR_KEYS).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field.');

export type UpdateCustomerProfileInput = z.infer<typeof updateCustomerProfileSchema>;
export type UpdateBusinessAppearanceInput = z.infer<typeof updateBusinessAppearanceSchema>;

/** What the signed-in customer sees about themselves. `identity` is the safe label for a "signed in as" chip. */
export interface CustomerProfileDto {
  displayName: string | null;
  bio: string | null;
  avatarKey: CustomerAvatarKey | null;
  /** Account name on file (never a phone or e-mail): used when no display name is set. */
  fullName: string | null;
  /** Masked sign-in handle for the "signed in as" chip, for example `a***@example.com` or `+1•••••67`. */
  maskedLogin: string | null;
}

export interface BusinessAppearanceDto {
  businessId: string;
  businessName: string;
  logoKey: BusinessLogoKey | null;
  brandColorKey: BusinessBrandColorKey | null;
}

/** The only customer fields a business may see of its own members. */
export interface MemberPublicIdentityDto {
  displayName: string | null;
  avatarKey: CustomerAvatarKey | null;
}
