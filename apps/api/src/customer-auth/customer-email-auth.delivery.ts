import type { EmailService } from '../notifications/email.service';
import type { RegistrationProofDelivery } from './customer-email-auth.service';

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The proof travels in the URL FRAGMENT (`#c=<challengeId>.<proof>`): fragments are not sent to servers, not logged
 * and not forwarded in referrers. The web page (a later stage) reads it client-side and submits it with the password.
 */
export const REGISTRATION_VERIFY_PATH = '/loyalty/signup/verify'; // apps/web/src/app/loyalty/signup/verify/page.tsx (the customer page, not the staff /signup)

export function buildRegistrationProofLink(webBaseUrl: string, challengeId: string, proof: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}${REGISTRATION_VERIFY_PATH}#c=${encodeURIComponent(`${challengeId}.${proof}`)}`;
}

/** Delivers the registration proof through the existing EmailService. Never logs the recipient, link or proof. */
export function createRegistrationProofDelivery(config: { email: EmailService; webBaseUrl: string }): RegistrationProofDelivery {
  return async ({ recipient, challengeId, proof }) => {
    const link = buildRegistrationProofLink(config.webBaseUrl, challengeId, proof);
    await config.email.send({
      to: recipient,
      subject: 'Confirm your email to create your Echo Grid account',
      html:
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827;">` +
        `<p style="font-size:20px;font-weight:700;margin:0 0 16px;">Echo Grid</p>` +
        `<p style="font-size:14px;line-height:1.5;">Use this link to confirm your email address and finish creating your account. It expires in 15 minutes.</p>` +
        `<p><a href="${escapeHtml(link)}" style="color:#059669;">Confirm email</a></p>` +
        `<p style="font-size:13px;color:#6b7280;">If you did not ask for this, you can ignore this email. We will never ask you for a password or a code by email.</p></div>`,
    });
  };
}
