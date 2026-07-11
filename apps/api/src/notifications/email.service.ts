/**
 * Email delivery abstraction (Notifications Block 2). ResendEmailService
 * calls Resend's REST API via plain fetch(), same "raw fetch against a
 * documented HTTP endpoint, no SDK" pattern already proven by
 * TwilioSmsService and AnthropicSummaryGenerator in this codebase --
 * Resend's SDK is Node-oriented and its Workers runtime compatibility isn't
 * worth the risk when a fetch() call is a handful of lines.
 *
 * Resend, not Cloudflare's own native Email Service binding -- live-searched
 * before choosing (2026-07-10). Cloudflare shipped a Workers-native Email
 * Service binding in public beta in April 2026 (no API key/secret, no
 * SPF/DKIM/DMARC config, ~5x cheaper than Postmark) which is architecturally
 * the better long-term fit for this project's demonstrated preference for
 * Cloudflare-native bindings over external HTTP APIs when quality is
 * comparable (native rate limiting over Durable Objects, native Web Crypto
 * over unofficial Argon2 WASM forks). It was NOT chosen for v1 because it's
 * ~3 months old at time of writing -- a real production-readiness risk for
 * a platform whose own standing instructions call for "enterprise-grade"
 * reliability, and its exact binding API/domain-verification requirements
 * weren't thoroughly verifiable in the time available for this block.
 * Resend is well-established, has a generous free tier (3,000/mo) that
 * comfortably covers a starting platform, and slots into the exact
 * interface+impl+dev-fallback pattern already proven twice in this
 * codebase. Revisit once Cloudflare Email Service is confirmed stable and
 * its binding API is verified in detail -- this abstraction makes that a
 * one-file swap, not a redesign.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface EmailService {
  send(message: EmailMessage): Promise<void>;
}

export interface ResendCredentials {
  apiKey: string;
  /** "Name <address@domain>" or a bare address -- Resend accepts both.
   * Business-configurable sender identity is future scope (per-business
   * "from" address is a real ask once white-labeling matters); one
   * platform-wide sender is the correct v1 scope. */
  fromAddress: string;
}

export class ResendEmailService implements EmailService {
  constructor(private readonly credentials: ResendCredentials) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.credentials.fromAddress,
        to: [message.to],
        subject: message.subject,
        html: message.html,
      }),
    });

    if (!response.ok) {
      // Response body isn't logged verbatim -- same caution as
      // TwilioSmsService/AnthropicSummaryGenerator, in case it ever echoes
      // back request content (a recipient's email address, message body).
      throw new Error(`Email delivery failed with status ${response.status}`);
    }
  }
}

/** Dev/staging fallback -- logs instead of sending, so notification content
 * is visible in `wrangler dev` output without a real Resend account or
 * spending real send quota. Never selected when ENVIRONMENT === 'production'. */
export class ConsoleEmailService implements EmailService {
  async send(message: EmailMessage): Promise<void> {
    console.log(`[ConsoleEmailService] would send to ${message.to}: ${message.subject}`);
  }
}

export function createEmailService(
  environment: 'development' | 'staging' | 'production',
  credentials: ResendCredentials,
): EmailService {
  return environment === 'production' ? new ResendEmailService(credentials) : new ConsoleEmailService();
}
