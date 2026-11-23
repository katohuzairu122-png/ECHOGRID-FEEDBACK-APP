/**
 * Reason-coded diagnostics for the generic 503 that the customer email authentication surface answers.
 *
 * The response is deliberately identical for every internal failure (fail closed, nothing for an attacker to learn), which also
 * hides the cause from the operator. This writes ONE structured line to the Worker log so an operator can tell the causes apart.
 *
 * What it may contain: a fixed reason code, the request surface, the NAMES of missing settings, and an error class name.
 * What it must never contain: an email address, an IP address, a secret or its length, a token, or an error message (messages can
 * embed binding or connection details). Callers cannot pass free text: every field is a closed set or a validated setting name.
 */
export type EmailAuthUnavailableReason =
  | 'config_incomplete' // a required setting is missing or invalid (names are listed)
  | 'runtime_open_failed' // building the runtime (database, hasher, mailer, limiter) threw
  | 'untrusted_source' // no verified signed attribution from the web Worker (secret mismatch, unsigned, skew, no address)
  | 'limiter_error' // the shared rate-limit Durable Object call failed
  | 'unhandled_error'; // an error escaped a route handler

export type EmailAuthSurface = 'delivery' | 'login' | 'complete' | 'runtime';

const SETTING_NAME = /^[A-Z][A-Z0-9_*]{2,63}$/;

export function logEmailAuthUnavailable(
  reason: EmailAuthUnavailableReason,
  detail: { surface: EmailAuthSurface; missing?: readonly string[]; error?: unknown },
): void {
  const line: Record<string, unknown> = { event: 'customer_email_auth_unavailable', reason, surface: detail.surface };
  if (detail.missing) {
    // Only things that look like setting names; anything else (e.g. the TTL coherence note) is reduced to a fixed label.
    line.missing = detail.missing.map((name) => (SETTING_NAME.test(name) ? name : 'invalid_or_incoherent_setting'));
  }
  if (detail.error instanceof Error) line.errorName = detail.error.name.slice(0, 64);
  else if (detail.error !== undefined) line.errorName = 'non_error_thrown';
  try {
    console.warn(JSON.stringify(line));
  } catch {
    // Logging must never change the response.
  }
}


/**
 * PROD-AUTH-05: operational milestones for email registration. No recipient, proof, challenge ID,
 * request body, identifier digest, IP or error message may be supplied or logged.
 * Correlation uses the existing Cloudflare invocation trace, not customer identifiers.
 */
export type RegistrationDeliveryStage =
  | 'request_suppressed'
  | 'challenge_created'
  | 'delivery_attempted'
  | 'provider_accepted'
  | 'delivery_failed'
  | 'request_failed';

export function logRegistrationDelivery(
  stage: RegistrationDeliveryStage,
  detail?: { providerStatus?: number; failureKind?: 'provider_http' | 'transport_or_internal' },
): void {
  const line: Record<string, unknown> = { event: 'customer_registration_delivery', stage };
  // Only a valid HTTP error status is permitted. Never log provider bodies or free-form errors.
  if (detail?.providerStatus !== undefined &&
      Number.isInteger(detail.providerStatus) &&
      detail.providerStatus >= 400 && detail.providerStatus <= 599) {
    line.providerStatus = detail.providerStatus;
  }
  if (detail?.failureKind) line.failureKind = detail.failureKind;
  try {
    console.info(JSON.stringify(line));
  } catch {
    // Diagnostics must never change signup behavior.
  }
}
