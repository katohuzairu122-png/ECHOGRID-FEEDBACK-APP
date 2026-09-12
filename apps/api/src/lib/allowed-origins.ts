import { AppError } from './errors';

/**
 * The ALLOWED_ORIGINS allow-list, parsed once and shared.
 *
 * This project's convention has been to parse raw wrangler `[vars]` strings
 * at their point of use rather than in config/env.ts (see index.ts's note
 * beside the Anthropic spend limits). That held while ALLOWED_ORIGINS had
 * exactly one consumer. It now has two, and the second is a security check
 * -- so a discrepancy between the two parsers would not be untidy, it would
 * be a hole: an origin the CORS layer rejects but the redirect validator
 * accepts. One parser, both callers.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Rejects a client-supplied redirect URL whose origin is not one this
 * platform serves the web app from.
 *
 * WHY THIS IS NEEDED
 * `createCheckoutSessionSchema` and `createPortalSessionSchema` validate
 * `successUrl`/`cancelUrl`/`returnUrl` with `z.url()`, which accepts any
 * absolute URL. Those values were handed straight to Stripe as
 * `success_url` / `cancel_url` / `return_url`. So a holder of
 * `billing:manage` could produce a Stripe-hosted page that, on completion,
 * redirects to an origin they control.
 *
 * The severity comes from where the hop starts. A redirect off stripe.com,
 * arriving immediately after the user entered card details, is a far more
 * credible phishing surface than a link from anywhere else -- the user has
 * just been asked to trust a payment page, and the next page inherits that
 * trust. Bounding the destination to origins the platform actually serves
 * removes the primitive entirely.
 *
 * Checks the parsed ORIGIN, not a string prefix: `startsWith` would admit
 * `https://echo-grid.uk.attacker.example` against an allow-list entry of
 * `https://echo-grid.uk`, which is the classic way this check is written
 * wrong. Path, query and fragment are deliberately unconstrained -- the
 * app's own routes are not this module's business, only whose app it is.
 *
 * Fails closed. An unset or empty ALLOWED_ORIGINS yields an empty list and
 * every redirect is refused, matching how index.ts's CORS layer already
 * treats the same missing config.
 */
export function assertRedirectOriginAllowed(
  url: string,
  allowedOrigins: readonly string[],
  field: string,
): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    // Unreachable through the routes (Zod's z.url() runs first), but this
    // function must not depend on its callers having validated for it --
    // a parse failure here is a rejection, never a pass-through.
    throw new AppError(`${field} is not a valid URL.`, 422, 'REDIRECT_ORIGIN_NOT_ALLOWED');
  }

  // `new URL('https://x')` normalises to origin 'https://x', with no
  // trailing slash and lowercased host, so a comparison against a trimmed
  // config entry written the same way is exact. An allow-list entry with a
  // trailing slash or a path would simply never match, which is the safe
  // direction to be wrong in.
  if (!allowedOrigins.includes(origin)) {
    throw new AppError(
      `${field} must point at this application.`,
      422,
      'REDIRECT_ORIGIN_NOT_ALLOWED',
    );
  }
}
