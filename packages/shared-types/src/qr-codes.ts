import { z } from 'zod';
import { localeSchema } from './i18n';

export const qrCodeSchema = z.object({
  id: z.uuid(),
  token: z.string(),
  status: z.enum(['active', 'revoked']),
});

export type QrCodeDto = z.infer<typeof qrCodeSchema>;

/**
 * Public GET /qr/:token response -- just enough for the landing page to
 * render itself ("Leave feedback for {branchName}"). The token is already
 * known client-side from the URL, so it isn't echoed back here.
 *
 * defaultLocale/defaultCurrency/defaultTimezone were added in i18n &
 * Multi-Currency Block 2 so the two fully-anonymous QR landing pages
 * (feedback/[token], loyalty/[token]) can render in the scanned branch's
 * business's own locale -- these pages have no session and no other route
 * param to resolve a business from, and the API handler already loads the
 * full business row for businessName, so this is a free addition, not an
 * extra query.
 */
export const qrResolveSchema = z.object({
  branchId: z.uuid(),
  branchName: z.string(),
  businessName: z.string(),
  defaultLocale: localeSchema,
  defaultCurrency: z.string(),
  defaultTimezone: z.string(),
});

export type QrResolveDto = z.infer<typeof qrResolveSchema>;
