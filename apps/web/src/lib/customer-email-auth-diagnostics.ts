import 'server-only';

/**
 * Reason-coded diagnostics for the generic "not available" answer of the customer email sign-up and sign-in actions.
 *
 * The screens deliberately show one message for every internal failure, which hides the cause from the operator. This writes ONE
 * structured line to the Worker log. It may contain only: a fixed reason code, a fixed action name, an HTTP status NUMBER, and an
 * error CLASS name. It must never contain an email address, password, proof, token, IP address, URL, secret or error message
 * (messages can embed addresses and binding details); callers cannot pass free text.
 */
export type EmailAuthWebUnavailableReason =
  | 'web_flag_disabled' // CUSTOMER_EMAIL_AUTH_ENABLED was not exactly "true" when the action ran
  | 'api_fetch_failed' // the server-to-server call threw before an HTTP answer (network, redirect, runtime error)
  | 'api_unexpected_status' // the API answered with a status the screen does not map (for example 503)
  | 'api_response_unreadable'; // a 200 whose session credentials could not be read

export type EmailAuthWebAction = 'register_request' | 'register_complete' | 'login';

export function logEmailAuthWebUnavailable(
  reason: EmailAuthWebUnavailableReason,
  detail: { action: EmailAuthWebAction; status?: number; error?: unknown },
): void {
  const line: Record<string, unknown> = { event: 'customer_email_auth_web_unavailable', reason, action: detail.action };
  if (typeof detail.status === 'number' && Number.isInteger(detail.status) && detail.status >= 100 && detail.status <= 599) {
    line.status = detail.status;
  }
  if (detail.error instanceof Error) line.errorName = detail.error.name.slice(0, 64);
  else if (detail.error !== undefined) line.errorName = 'non_error_thrown';
  try {
    console.warn(JSON.stringify(line));
  } catch {
    // Logging must never change what the screen shows.
  }
}
