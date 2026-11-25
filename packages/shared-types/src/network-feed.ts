import { z } from 'zod';
import { NETWORK_DRAFT_HANDLE } from './network-drafts';

/** Read-only Feed contract. `business_post` items exist only while business distribution is open (BCOMM-04) and the business is published and active. */
export const NETWORK_FEED_CONTENT_CLASSES = ['official', 'business_post'] as const;
export const NETWORK_FEED_MAX_LIMIT = 50;
export const NETWORK_FEED_CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const httpsUrl = z.url({ protocol: /^https$/ });

export const networkFeedItemSchema = z.object({
  handle: z.string().regex(NETWORK_DRAFT_HANDLE),
  contentClass: z.enum(NETWORK_FEED_CONTENT_CLASSES),
  businessName: z.string().nullable(),
  /** BCOMM-04: the published profile's opaque handle for a business post (null for official). Never an internal id. */
  businessHandle: z.string().regex(NETWORK_DRAFT_HANDLE).nullable().optional(),
  body: z.string().min(1).max(2000),
  // Validate without normalizing the already published string.
  linkUrl: z
    .string()
    .refine((value) => httpsUrl.safeParse(value).success)
    .nullable(),
  contentLocale: z.string(),
  publishedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
});

/** Closed projection, bounded page and opaque cursor. Unknown fields are stripped, never forwarded. */
export const networkFeedPageSchema = z.object({
  items: z.array(networkFeedItemSchema).max(NETWORK_FEED_MAX_LIMIT),
  nextCursor: z.string().regex(NETWORK_FEED_CURSOR).nullable(),
});

export type NetworkFeedItemDto = z.infer<typeof networkFeedItemSchema>;
export type NetworkFeedPageDto = z.infer<typeof networkFeedPageSchema>;
